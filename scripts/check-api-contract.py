#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Junctura Contributors
# SPDX-License-Identifier: Apache-2.0
"""API contract check for the planned Junctura Workspace Tier 3 API.

Dev-only check, sibling of scripts/check-pack-schemas.py: validates the
OpenAPI document at docs/contracts/workspace-api.openapi.json and the
synthetic fixtures under examples/api/ against it, without any network or
runtime. For every fixture the recorded response body must match the
contract schema of its status. Fixtures whose operation accepts a JSON body
must validate against the request schema, while invalid-input fixtures must
be rejected by it. Replay fixtures reuse one Idempotency-Key with an
identical body and an identical recorded response, and every mutating
operation must also carry a same-key different-body case recorded as 409/422
idempotency_key_reused. Coverage is enforced: each operation needs a success
fixture and each mutating operation needs a negative one (forbidden,
invalid-input or conflict).

The upstream DX-OS calls each operation composes are documentation only
(x-workspace-upstream), pinned to the checkout excerpt under
.junctura/dxos-reference; this check never reads or calls them.

Run: python3 scripts/check-api-contract.py
"""

import json
import re
import sys
from pathlib import Path

from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / "docs" / "contracts" / "workspace-api.openapi.json"
FIXTURES_DIR = ROOT / "examples" / "api"
RESOURCE_NAME = "workspace-api.openapi.json"
HTTP_METHODS = ("get", "post", "put", "patch", "delete")
SCENARIOS = ("success", "replay", "replay-conflict", "forbidden", "invalid-input", "conflict")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
CURSOR_RE = re.compile(r"^[A-Za-z0-9_-]+$")
JSON_MEDIA = "application/json"

# The contract document, set once in main; local $refs resolve against it.
document_holder = [None]


def load_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def pointer_get(document, pointer):
    """Resolves a local `#/a/b` JSON pointer inside the contract document."""
    if pointer == "#":
        return document
    if not pointer.startswith("#/"):
        raise KeyError(f"only local pointers are supported: {pointer}")
    node = document
    for raw in pointer[2:].split("/"):
        node = node[raw.replace("~1", "/").replace("~0", "~")]
    return node


def local_ref_problems(node, where):
    """Every local $ref in the document must point at something that exists."""
    problems = []
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str) and ref.startswith("#"):
            try:
                pointer_get(document_holder[0], ref)
            except (KeyError, IndexError):
                problems.append(f"{where}: unresolvable $ref {ref}")
        for key, value in node.items():
            problems += local_ref_problems(value, f"{where}/{key}")
    elif isinstance(node, list):
        for index, value in enumerate(node):
            problems += local_ref_problems(value, f"{where}/{index}")
    return problems


def build_registry(document):
    resource = Resource(contents=document, specification=DRAFT202012)
    registry = Registry().with_resource(RESOURCE_NAME, resource)
    return registry


def ref_validator(pointer, registry):
    """A validator for one contract schema; refs resolve into the document."""
    return Draft202012Validator({"$ref": f"{RESOURCE_NAME}{pointer}"}, registry=registry)


def contract_problems(document, registry):
    """Structural sanity of the contract itself."""
    problems = []
    if not str(document.get("openapi", "")).startswith("3.1"):
        problems.append("contract: openapi must be 3.1.x so schemas are draft 2020-12")
    operations = {}
    for path, item in document.get("paths", {}).items():
        for method in HTTP_METHODS:
            if method not in item:
                continue
            op = item[method]
            op_id = op.get("operationId")
            if not op_id:
                problems.append(f"contract: {method} {path} has no operationId")
            elif op_id in operations:
                problems.append(f"contract: duplicate operationId {op_id}")
            else:
                operations[op_id] = (path, method, op)
            if not op.get("responses"):
                problems.append(f"contract: {method} {path} has no responses")
    for name, schema in document.get("components", {}).get("schemas", {}).items():
        try:
            Draft202012Validator.check_schema(schema)
        except Exception as error:  # jsonschema.SchemaError or anything unexpected
            problems.append(f"contract: components/schemas/{name} is not a valid draft 2020-12 schema: {error}")
    for name, response in document.get("components", {}).get("responses", {}).items():
        if JSON_MEDIA not in response.get("content", {}):
            problems.append(f"contract: components/responses/{name} has no {JSON_MEDIA} representation")
    problems += local_ref_problems(document, "contract")
    return operations, problems


def json_request_schema(operation):
    content = operation.get("requestBody", {}).get("content", {})
    return content.get(JSON_MEDIA, {}).get("schema")


def response_schema(operation, status):
    response = operation.get("responses", {}).get(str(status))
    if response is None:
        return None
    if "$ref" in response:
        response = pointer_get(document_holder[0], response["$ref"])
    return response.get("content", {}).get(JSON_MEDIA, {}).get("schema")


def required_idempotency_key(operation):
    for parameter in operation.get("parameters", []):
        resolved = pointer_get(document_holder[0], parameter["$ref"]) if "$ref" in parameter else parameter
        if resolved.get("name") == "Idempotency-Key" and resolved.get("in") == "header":
            return bool(resolved.get("required"))
    return False


def fixture_problems(fixture, label, operations, registry):
    problems = []
    op_id = fixture.get("operationId")
    scenario = fixture.get("scenario")
    if op_id not in operations:
        return [f"{label}: unknown operationId {op_id!r}"]
    if scenario not in SCENARIOS:
        return [f"{label}: unknown scenario {scenario!r}"]
    path, method, operation = operations[op_id]
    request = fixture.get("request") or {}
    response = fixture.get("response") or {}
    if not isinstance(request, dict) or not isinstance(response, dict):
        return [f"{label}: request and response must be objects"]
    if "description" not in fixture:
        problems.append(f"{label}: missing description of the scenario")

    # Headers: a required Idempotency-Key must be supplied and be a UUID; an
    # optional one, when present, must also be a UUID.
    headers = request.get("headers") or {}
    key = headers.get("Idempotency-Key")
    if required_idempotency_key(operation) and not key:
        problems.append(f"{label}: missing required Idempotency-Key header")
    if key is not None and not UUID_RE.match(str(key)):
        problems.append(f"{label}: Idempotency-Key {key!r} is not a lowercase UUID")

    # Query: light checks on the paging params declared by the contract.
    for name, value in (request.get("query") or {}).items():
        if name == "limit" and not (str(value).isdigit() and 1 <= int(value) <= 100):
            problems.append(f"{label}: limit {value!r} is outside 1..100")
        if name == "cursor" and not CURSOR_RE.match(str(value)):
            problems.append(f"{label}: cursor {value!r} is not an opaque cursor")

    # Response: the status must be declared and the body must match its schema.
    status = response.get("status")
    schema = response_schema(operation, status)
    if schema is None:
        problems.append(f"{label}: status {status!r} is not declared for {method} {path}")
    else:
        validator = ref_validator(schema_pointer(schema), registry)
        errors = list(validator.iter_errors(response.get("body")))
        for error in errors:
            problems.append(f"{label}: response body violates the {status} schema: {error.json_path}: {error.message}")

    # Request: JSON bodies follow the request schema; invalid-input fixtures
    # must be rejected by it. Operations without a JSON body (multipart file
    # upload) are documented in the fixture and only checked on the response.
    request_schema = json_request_schema(operation)
    body = request.get("body")
    if request_schema is not None:
        validator = ref_validator(schema_pointer(request_schema), registry)
        errors = list(validator.iter_errors(body))
        if scenario == "invalid-input":
            if not errors:
                problems.append(f"{label}: invalid-input request was accepted by the request schema")
        elif errors:
            problems.append(f"{label}: request body violates the request schema: " + "; ".join(f"{e.json_path}: {e.message}" for e in errors))
    elif scenario == "invalid-input" and method == "post":
        if status != 400:
            problems.append(f"{label}: invalid-input on a multipart operation must record status 400")
    return problems


def schema_pointer(schema):
    """Pointer of a schema that is a local $ref wrapper; inline schemas are
    validated against the whole document via the registry."""
    if isinstance(schema, dict) and set(schema) == {"$ref"} and schema["$ref"].startswith("#/"):
        return schema["$ref"]
    raise AssertionError("fixture validation expects a $ref schema; extend the contract instead of inlining")


def replay_group_problems(fixtures_by_op, operations):
    """Replay semantics: one key, identical bodies, identical first response."""
    problems = []
    for op_id, fixtures in fixtures_by_op.items():
        path, method, operation = operations[op_id]
        groups = {}
        for fixture in fixtures:
            key = (fixture.get("request") or {}).get("headers", {}).get("Idempotency-Key")
            if key:
                groups.setdefault(key, []).append(fixture)
        for key, members in groups.items():
            plain = [f for f in members if f["scenario"] in ("success", "replay", "forbidden", "invalid-input")]
            conflicts = [f for f in members if f["scenario"] == "replay-conflict"]
            distinct_bodies = [json.dumps(f["request"].get("body"), sort_keys=True) for f in plain]
            if len(set(distinct_bodies)) > 1:
                problems.append(f"{op_id}: key {key} is shared by fixtures with different bodies: {sorted({f['name'] for f in plain})}")
                continue
            responses = {(f["response"]["status"], json.dumps(f["response"].get("body"), sort_keys=True)) for f in plain}
            if len(responses) > 1:
                problems.append(f"{op_id}: replaying key {key} must record one identical first response, saw {sorted(responses)}")
            for conflict in conflicts:
                if json.dumps(conflict["request"].get("body"), sort_keys=True) in distinct_bodies:
                    problems.append(f"{op_id}: {conflict['name']} claims key {key} with a body identical to the original")
                if conflict["response"]["status"] not in (409, 422) or conflict["response"].get("body", {}).get("error") != "idempotency_key_reused":
                    problems.append(f"{op_id}: {conflict['name']} must record 409/422 idempotency_key_reused")
    return problems


def coverage_problems(fixtures_by_op, operations):
    problems = []
    for op_id, (path, method, operation) in operations.items():
        fixtures = fixtures_by_op.get(op_id, [])
        scenarios = {f["scenario"] for f in fixtures}
        if "success" not in scenarios:
            problems.append(f"coverage: {op_id} has no success fixture")
        if method == "post" and not (scenarios & {"forbidden", "invalid-input", "conflict"}):
            problems.append(f"coverage: POST {path} needs a forbidden, invalid-input or conflict fixture")
        if method == "post" and required_idempotency_key(operation):
            if "replay" not in scenarios:
                problems.append(f"coverage: {op_id} needs a replay fixture reusing its Idempotency-Key")
            if "replay-conflict" not in scenarios:
                problems.append(f"coverage: {op_id} needs a replay-conflict fixture reusing its key with a different body")
    return problems


def main():
    document = load_json(CONTRACT)
    document_holder[0] = document
    registry = build_registry(document)
    operations, problems = contract_problems(document, registry)

    fixtures_by_op = {}
    fixture_paths = sorted(FIXTURES_DIR.glob("*.json"))
    if not fixture_paths:
        problems.append(f"no fixtures found under {FIXTURES_DIR.relative_to(ROOT)}")
    for path in fixture_paths:
        label = str(path.relative_to(ROOT))
        try:
            fixture = load_json(path)
        except (OSError, json.JSONDecodeError) as error:
            problems.append(f"{label}: not readable JSON: {error}")
            continue
        fixture["name"] = path.stem
        problems += fixture_problems(fixture, label, operations, registry)
        fixtures_by_op.setdefault(fixture.get("operationId"), []).append(fixture)

    if not problems:
        problems += replay_group_problems(fixtures_by_op, operations)
    if not problems:
        problems += coverage_problems(fixtures_by_op, operations)

    if problems:
        for problem in problems:
            print(f"api contract violation: {problem}", file=sys.stderr)
        return 1
    operation_count = len(operations)
    fixture_count = sum(len(fixtures) for fixtures in fixtures_by_op.values())
    print(f"OK: contract valid with {operation_count} operations, {fixture_count} fixtures match request/response schemas, replay and coverage rules hold")
    return 0


if __name__ == "__main__":
    sys.exit(main())
