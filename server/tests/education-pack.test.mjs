// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Focused regression tests for the runnable Education pack (examples/packs/education/).
// The draft only declared bare userTask elements; the promoted pack must have
// connected Flowable start/userTask/gateway/end flows with valid sequence flows,
// candidate-group role bindings, reachable decision paths for every declared
// decision, and deadline metadata consistent with the manifest
// (docs/PACK_FORMAT.md). All structural assertions run on the pack as read
// through the preflight reader plus a namespace-aware parse of its BPMN.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SaxesParser } from "saxes";
import { readPack } from "../packs.mjs";

const EDUCATION = fileURLToPath(new URL("../../examples/packs/education/", import.meta.url));
const BPMN_NS = "http://www.omg.org/spec/BPMN/20100524/MODEL";
const FLOWABLE_NS = "http://flowable.org/bpmn";
const FLOW_NODES = new Set(["startEvent", "endEvent", "userTask", "exclusiveGateway"]);

/**
 * Parses one BPMN source into { nodes, flows }: flow nodes by id (kind, name,
 * candidateGroups, documentation) and sequenceFlows with sourceRef/targetRef
 * and their conditionExpression text, if any.
 */
function parseGraph(xml) {
  const nodes = new Map();
  const flows = [];
  const stack = [];
  let openFlow = null;
  let openTask = null;
  let failed = null;
  const parser = new SaxesParser({ xmlns: true });
  parser.on("error", error => { failed ??= error.message; });
  parser.on("opentag", node => {
    const attrs = {};
    for (const attribute of Object.values(node.attributes ?? {})) {
      if (attribute.uri === "" || attribute.uri === FLOWABLE_NS) attrs[attribute.local] = attribute.value;
    }
    stack.push({ local: node.local, uri: node.uri, buf: "" });
    if (node.uri !== BPMN_NS) return;
    if (FLOW_NODES.has(node.local)) {
      nodes.set(attrs.id, { id: attrs.id, kind: node.local, name: attrs.name ?? "", groups: attrs.candidateGroups?.split(",").map(g => g.trim()) ?? [], documentation: "" });
      if (node.local === "userTask") openTask = attrs.id;
    } else if (node.local === "sequenceFlow") {
      openFlow = flows.length;
      flows.push({ id: attrs.id, sourceRef: attrs.sourceRef, targetRef: attrs.targetRef, condition: null });
    }
  });
  parser.on("text", text => {
    if (stack.length) stack[stack.length - 1].buf += String(text);
  });
  parser.on("closetag", node => {
    const entry = stack.pop();
    if (node.uri !== BPMN_NS) return;
    if (node.local === "sequenceFlow") {
      openFlow = null;
    } else if (node.local === "conditionExpression" && openFlow != null) {
      flows[openFlow].condition = entry.buf.trim();
    } else if (node.local === "documentation" && openTask != null) {
      nodes.get(openTask).documentation = entry.buf.trim();
    } else if (node.local === "userTask") {
      openTask = null;
    }
  });
  try {
    parser.write(xml).close();
  } catch (error) {
    failed ??= error.message;
  }
  assert.ifError(failed);
  return { nodes, flows };
}

/** Decision branch of a condition expression, e.g. ${decision == 'tiep-nhan'} → "tiep-nhan". */
function branchDecision(condition) {
  const match = /^\$\{\s*decision\s*==\s*'([^'$\\{}]+)'\s*\}$/.exec(condition ?? "");
  return match ? match[1] : null;
}

/** All flows that carry the decisions leaving `task` (directly or via its gateway). */
function outgoingBranches(task, flows, nodes) {
  const branches = [];
  for (const flow of flows.filter(f => f.sourceRef === task.id)) {
    if (flow.condition) branches.push(flow);
    else {
      const target = nodes.get(flow.targetRef);
      if (target?.kind === "exclusiveGateway") {
        branches.push(...flows.filter(f => f.sourceRef === target.id && f.condition));
      }
    }
  }
  return branches;
}

/** Ids reachable from `from` treating every sequence flow as traversable. */
function reachable(from, flows) {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const current = queue.shift();
    for (const flow of flows.filter(f => f.sourceRef === current)) {
      if (!seen.has(flow.targetRef)) {
        seen.add(flow.targetRef);
        queue.push(flow.targetRef);
      }
    }
  }
  return seen;
}

let packResult;

test("the education pack still reads: two schools, one education office, two process types", async () => {
  packResult = await readPack(EDUCATION);
  assert.equal(packResult.ok, true);
  const { manifest, units } = packResult.pack;
  assert.equal(manifest.id, "education");
  assert.equal(manifest.recordTypes.length, 2);
  assert.deepEqual(manifest.recordTypes.map(recordType => recordType.id), ["chuyen-truong", "cap-ban-sao-hoc-ba"]);
  const unitList = units.units;
  assert.equal(unitList.filter(unit => unit.unitType === "truong").length, 2, "two schools");
  assert.equal(unitList.filter(unit => unit.unitType === "phong-giao-duc").length, 1, "one education office");
  const office = unitList.find(unit => unit.unitType === "phong-giao-duc");
  assert.ok(unitList.filter(unit => unit.unitType === "truong").every(unit => unit.parent === office.id), "both schools belong to the office");
});

test("every BPMN process is one connected start/userTask/gateway/end graph", () => {
  assert.ok(packResult.ok, "the pack must read before graph checks");
  for (const workflow of packResult.pack.workflows) {
    const { nodes, flows } = parseGraph(workflow.xml);
    assert.ok(nodes.size >= 5, `${workflow.bpmn} declares flow nodes`);
    assert.ok(flows.length >= nodes.size - 1, `${workflow.bpmn} declares sequence flows, unlike the draft`);
    for (const flow of flows) {
      assert.ok(nodes.has(flow.sourceRef), `${workflow.bpmn}: ${flow.id} sourceRef ${flow.sourceRef} is a declared node`);
      assert.ok(nodes.has(flow.targetRef), `${workflow.bpmn}: ${flow.id} targetRef ${flow.targetRef} is a declared node`);
    }
    for (const node of nodes.values()) {
      const outgoing = flows.filter(flow => flow.sourceRef === node.id);
      const incoming = flows.filter(flow => flow.targetRef === node.id);
      if (node.kind === "startEvent") assert.ok(outgoing.length >= 1, `start ${node.id} has an outgoing flow`);
      if (node.kind === "endEvent") assert.ok(incoming.length >= 1, `end ${node.id} has an incoming flow`);
      if (node.kind === "userTask" || node.kind === "exclusiveGateway") {
        assert.ok(outgoing.length >= 1 && incoming.length >= 1, `${node.kind} ${node.id} sits on the flow`);
      }
    }
  }
});

test("start reaches every user task and every task reaches an end", () => {
  for (const workflow of packResult.pack.workflows) {
    const { nodes, flows } = parseGraph(workflow.xml);
    const start = [...nodes.values()].find(node => node.kind === "startEvent");
    assert.ok(start, `${workflow.bpmn} has a startEvent`);
    const fromStart = reachable(start.id, flows);
    for (const node of nodes.values()) {
      if (node.kind === "userTask") {
        assert.ok(fromStart.has(node.id), `${workflow.bpmn}: start reaches ${node.id}`);
        const forward = reachable(node.id, flows);
        assert.ok(
          [...forward].some(id => nodes.get(id)?.kind === "endEvent"),
          `${workflow.bpmn}: ${node.id} can reach an endEvent`,
        );
      }
    }
  }
});

test("each step binds its role as candidate group and covers every declared decision", () => {
  for (const [index, workflow] of packResult.pack.manifest.workflows.entries()) {
    const contents = packResult.pack.workflows[index];
    const { nodes, flows } = parseGraph(contents.xml);
    for (const step of workflow.steps) {
      const task = nodes.get(step.id);
      assert.ok(task, `${workflow.bpmn} has the userTask ${step.id}`);
      assert.deepEqual(task.groups, [step.role], `${step.id} is assigned to group ${step.role}`);
      if (step.decisions.length === 1) {
        // A single-decision step realizes it by completing the task: it flows on directly.
        assert.ok(flows.some(flow => flow.sourceRef === task.id), `${step.id} flows on after its only decision`);
        continue;
      }
      const branches = outgoingBranches(task, flows, nodes);
      assert.ok(branches.length >= 1, `${step.id} has decision branches in ${workflow.bpmn}`);
      const branchDecisions = branches.map(branch => branchDecision(branch.condition));
      assert.deepEqual(
        [...new Set(branchDecisions)].sort(),
        [...step.decisions.map(decision => decision.id)].sort(),
        `${workflow.bpmn}: the gateway branches of ${step.id} are exactly its declared decisions`,
      );
      const forward = reachable(task.id, flows);
      for (const branch of branches) {
        assert.ok(forward.has(branch.targetRef), `${workflow.bpmn}: the ${branchDecision(branch.condition)} branch of ${step.id} stays reachable`);
      }
    }
  }
});

test("reject decisions end the process, request-info loops back to the receiving step", () => {
  for (const [index, workflow] of packResult.pack.manifest.workflows.entries()) {
    const { nodes, flows } = parseGraph(packResult.pack.workflows[index].xml);
    for (const step of workflow.steps) {
      const task = nodes.get(step.id);
      for (const decision of step.decisions) {
        const branch = outgoingBranches(task, flows, nodes).find(flow => branchDecision(flow.condition) === decision.id);
        if (!branch) {
          // the single-decision step: completing the task realizes the decision
          assert.equal(decision.outcome, "approve", `${workflow.bpmn}: ${decision.id} has no branch, so it must be the step's only approve decision`);
          continue;
        }
        const target = nodes.get(branch.targetRef);
        if (decision.outcome === "reject") {
          assert.equal(target.kind, "endEvent", `${workflow.bpmn}: ${decision.id} ends the process`);
        }
        if (decision.outcome === "request-info") {
          assert.equal(target.kind, "userTask", `${workflow.bpmn}: ${decision.id} returns to the receiving step ${target.id}`);
          assert.equal(target.id, workflow.steps[0].id, `${workflow.bpmn}: ${decision.id} loops back to ${workflow.steps[0].id}`);
        }
      }
    }
  }
});

test("BPMN documentation keeps the deadline metadata consistent with the manifest", () => {
  for (const [index, workflow] of packResult.pack.manifest.workflows.entries()) {
    const { nodes } = parseGraph(packResult.pack.workflows[index].xml);
    for (const step of workflow.steps) {
      const match = /deadlineDays=(\d+)/.exec(nodes.get(step.id).documentation ?? "");
      assert.ok(match, `${workflow.bpmn}: ${step.id} documents its deadline`);
      assert.equal(Number(match[1]), step.deadlineDays, `${workflow.bpmn}: ${step.id} deadline matches deadlineDays=${step.deadlineDays}`);
      assert.match(nodes.get(step.id).documentation, new RegExp(`nhóm ${step.role}`), `${workflow.bpmn}: ${step.id} documentation names its group`);
    }
  }
});
