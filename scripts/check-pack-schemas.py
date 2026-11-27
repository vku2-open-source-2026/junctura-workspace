#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Junctura Contributors
# SPDX-License-Identifier: Apache-2.0
"""Schema contract check for the Junctura Workspace pack format v1.

Dev-only check: validates that the JSON Schemas in schemas/ are valid draft
2020-12 documents, validates every pack under examples/packs against them,
and proves the schemas reject the required negative cases (missing required
field, unsupported formatVersion, out-of-domain decision outcome and
unsupported/missing select options), plus a malformed-manifest case proving
dependent reads are skipped. Cross-file and cross-array invariants
belong to the pack reader (issue #8) and are documented in
docs/PACK_FORMAT.md, not enforced here.

Run: python3 scripts/check-pack-schemas.py
"""

import json
import sys
import tempfile
from copy import deepcopy
from pathlib import Path

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_DIR = ROOT / "schemas"
PACKS_DIR = ROOT / "examples" / "packs"


def load_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def schema_problems():
    problems = []
    for name in ("pack.schema.json", "units.schema.json"):
        schema = load_json(SCHEMA_DIR / name)
        try:
            Draft202012Validator.check_schema(schema)
        except Exception as error:  # jsonschema.SchemaError or anything unexpected
            problems.append(f"schemas/{name}: invalid draft 2020-12 schema: {error}")
    return problems


def instance_problems(instance, schema, label):
    validator = Draft202012Validator(schema)
    return [f"{label}: {error.json_path}: {error.message}" for error in sorted(validator.iter_errors(instance), key=str)]


def check_pack_dir(pack_dir, pack_schema, units_schema, label=None):
    """Validates one pack directory, reporting diagnostics instead of raising.

    The manifest is validated before anything else; if it is missing,
    unreadable or fails its schema, dependent reads (units.json) are skipped.
    """
    label = label or pack_dir.name
    problems = []
    try:
        pack = load_json(pack_dir / "pack.json")
    except (OSError, json.JSONDecodeError) as error:
        return [f"{label}/pack.json: not readable JSON: {error}"]
    manifest_problems = instance_problems(pack, pack_schema, f"{label}/pack.json")
    if manifest_problems:
        return manifest_problems
    # pack_schema guarantees unitsFile is the fixed, safe name "units.json".
    try:
        units = load_json(pack_dir / pack["unitsFile"])
    except (OSError, json.JSONDecodeError) as error:
        problems.append(f"{label}/{pack['unitsFile']}: not readable JSON: {error}")
        return problems
    return problems + instance_problems(units, units_schema, f"{label}/{pack['unitsFile']}")


def check_packs(pack_schema, units_schema):
    pack_dirs = sorted(path for path in PACKS_DIR.iterdir() if (path / "pack.json").exists())
    if not pack_dirs:
        return [f"no packs found under {PACKS_DIR.relative_to(ROOT)}"]
    problems = []
    for pack_dir in pack_dirs:
        problems += check_pack_dir(pack_dir, pack_schema, units_schema)
    return problems


def negative_cases(pack_schema, units_schema):
    """Mutations of the committed fixtures that each schema must reject."""
    pack = load_json(PACKS_DIR / "education" / "pack.json")
    units = load_json(PACKS_DIR / "health" / "units.json")
    cases = []

    def add_case(label, document, schema, json_path, message_part):
        cases.append((label, document, schema, json_path, message_part))

    missing = deepcopy(pack)
    del missing["workflows"][0]["steps"][0]["deadlineDays"]
    add_case(
        "missing required field",
        missing, pack_schema,
        "$.workflows[0].steps[0]",
        "is a required property",
    )

    for label, document, schema in (
        ("unsupported pack formatVersion", deepcopy(pack), pack_schema),
        ("unsupported units formatVersion", deepcopy(units), units_schema),
    ):
        document["formatVersion"] = 2
        add_case(label, document, schema, "$.formatVersion", "was expected")

    out_of_domain = deepcopy(pack)
    out_of_domain["workflows"][0]["steps"][0]["decisions"][0]["outcome"] = "maybe"
    add_case(
        "out-of-domain decision outcome",
        out_of_domain, pack_schema,
        "$.workflows[0].steps[0].decisions[0].outcome",
        "is not one of",
    )

    missing_options = deepcopy(pack)
    select_field = missing_options["workflows"][1]["steps"][0]["form"]["fields"][0]
    assert select_field["type"] == "select"
    del select_field["options"]
    add_case(
        "select field without options",
        missing_options, pack_schema,
        "$.workflows[1].steps[0].form.fields[0]",
        "'options' is a required property",
    )

    unsupported_options = deepcopy(pack)
    text_field = unsupported_options["workflows"][0]["steps"][0]["form"]["fields"][0]
    assert text_field["type"] != "select"
    text_field["options"] = ["Không được phép"]
    add_case(
        "options on a non-select field",
        unsupported_options, pack_schema,
        "$.workflows[0].steps[0].form.fields[0]",
        "should not be valid under",
    )
    return cases


def malformed_manifest_problem(pack_schema, units_schema):
    """A manifest without unitsFile must yield a schema error and no
    dependent reads (units.json is absent in this directory)."""
    with tempfile.TemporaryDirectory() as tmp:
        broken = Path(tmp) / "broken"
        broken.mkdir()
        manifest = deepcopy(load_json(PACKS_DIR / "education" / "pack.json"))
        del manifest["unitsFile"]
        (broken / "pack.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        problems = check_pack_dir(broken, pack_schema, units_schema, label="broken")
    if not problems:
        return "malformed manifest was accepted without a schema error"
    if not all(problem.startswith("broken/pack.json: ") for problem in problems):
        return f"dependent reads ran on a broken manifest: {problems}"
    return None


def main():
    pack_schema = load_json(SCHEMA_DIR / "pack.schema.json")
    units_schema = load_json(SCHEMA_DIR / "units.schema.json")
    problems = schema_problems() + check_packs(pack_schema, units_schema)

    for label, document, schema, json_path, message_part in negative_cases(pack_schema, units_schema):
        errors = [error for error in Draft202012Validator(schema).iter_errors(document)]
        hits = [error for error in errors if error.json_path == json_path and message_part in error.message]
        if not hits:
            seen = [f"{error.json_path}: {error.message}" for error in errors]
            problems.append(f"negative case '{label}' was not rejected as expected; validator saw {seen}")

    skipped = malformed_manifest_problem(pack_schema, units_schema)
    if skipped:
        problems.append(skipped)

    if problems:
        for problem in problems:
            print(f"pack schema contract violation: {problem}", file=sys.stderr)
        return 1
    pack_dirs = sorted(path.name for path in PACKS_DIR.iterdir() if (path / "pack.json").exists())
    negative_count = len(negative_cases(pack_schema, units_schema))
    print(f"OK: schemas are valid draft 2020-12, {len(pack_dirs)} pack(s) valid, {negative_count} negative cases and the malformed-manifest case rejected")
    return 0


if __name__ == "__main__":
    sys.exit(main())
