// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Structured diagram of one BPMN 2.0 process, for the public pack projection.
//
// The projection never ships the raw BPMN source: it ships business nodes
// (start events, user tasks, gateways, end events — attributes only, never
// documentation or condition text) and the sequence-flow edges between them.
// Edges that leave a gateway get the user-facing label of the manifest
// decision their condition references, resolved here on the server; the
// condition expressions themselves stay private. Namespace-aware via saxes,
// the same parser discipline the pack reader uses (DTDs already rejected
// upstream by `readPack`).
import { SaxesParser } from "saxes";

const BPMN_NS = "http://www.omg.org/spec/BPMN/20100524/MODEL";
const FLOWABLE_NS = "http://flowable.org/bpmn";

/** BPMN elements that carry the business flow; anything else is ignored. */
const KINDS = new Map([
  ["startEvent", "start"],
  ["userTask", "task"],
  ["exclusiveGateway", "gateway"],
  ["parallelGateway", "gateway"],
  ["inclusiveGateway", "gateway"],
  ["endEvent", "end"],
]);

const DECISION_IN_CONDITION = /decision\s*==\s*['"]([^'"]+)['"]/;

const attributeOf = (attributes, uri, local) => {
  for (const attribute of Object.values(attributes)) {
    if (attribute.uri === uri && attribute.local === local) return attribute.value;
  }
  return null;
};

/** One parse of the XML: business nodes with Flowable candidate groups, and the sequence flows with their (private) condition text. */
function parseProcess(xml) {
  const nodes = [];
  const flows = [];
  let openFlow = null;
  let condition = null;
  let inProcess = false;
  let failed = false;
  const fail = () => { failed = true; };

  const parser = new SaxesParser({ xmlns: true });
  parser.on("error", fail);
  parser.on("opentag", node => {
    if (failed) return;
    if (node.uri !== BPMN_NS) return;
    if (node.local === "process") inProcess = true;
    if (!inProcess) return;
    const kind = KINDS.get(node.local);
    if (kind) {
      const groups = (attributeOf(node.attributes, FLOWABLE_NS, "candidateGroups") ?? "")
        .split(/[\s,]+/).filter(Boolean);
      nodes.push({
        id: attributeOf(node.attributes, "", "id") ?? "",
        name: attributeOf(node.attributes, "", "name") ?? "",
        kind,
        ...(groups.length > 0 ? { groups } : {}),
      });
    } else if (node.local === "sequenceFlow") {
      openFlow = {
        from: attributeOf(node.attributes, "", "sourceRef") ?? "",
        to: attributeOf(node.attributes, "", "targetRef") ?? "",
        name: attributeOf(node.attributes, "", "name"),
      };
      flows.push(openFlow);
    } else if (node.local === "conditionExpression" && openFlow) {
      condition = { flow: openFlow, text: "" };
    }
  });
  parser.on("text", text => {
    if (condition) condition.text += text;
  });
  parser.on("closetag", node => {
    if (failed) return;
    if (node.uri !== BPMN_NS) return;
    if (condition && node.local === "conditionExpression") {
      condition.flow.conditionText = condition.text;
      condition = null;
    }
    if (node.local === "sequenceFlow") openFlow = null;
    if (node.local === "process") inProcess = false;
  });
  try {
    parser.write(xml).close();
  } catch {
    return null;
  }
  return failed ? null : { nodes, flows };
}

/**
 * The projection shape of one workflow diagram, built from the BPMN source and
 * the manifest step list of the same workflow:
 *   - `nodes`: every business element, in document order — id, user-facing
 *     name, kind, candidate groups (public role groups of the pack);
 *   - `edges`: every sequence flow as `{ from, to, label }`; `label` is the
 *     manifest decision's user-facing label when the flow's condition names a
 *     decision of the task the flow's gateway follows, otherwise the flow's
 *     own name, otherwise absent;
 *   - `path`: node ids walked from the start event following the first
 *     outgoing edge at each node (the happy path), for progress displays.
 * No raw XML, no condition text, no documentation ever leaves this function.
 */
export function diagramOf(xml, steps) {
  const parsed = parseProcess(xml);
  if (!parsed) return { nodes: [], edges: [], path: [] };
  const { nodes, flows } = parsed;

  const byId = new Map(nodes.map(node => [node.id, node]));
  const outgoing = new Map();
  const incoming = new Map();
  for (const flow of flows) {
    if (!outgoing.has(flow.from)) outgoing.set(flow.from, []);
    outgoing.get(flow.from).push(flow);
    if (!incoming.has(flow.to)) incoming.set(flow.to, []);
    incoming.get(flow.to).push(flow);
  }

  // Decision labels of each manifest step, attached to its task node (step id
  // = userTask id, as the pack reader enforces).
  for (const step of steps) {
    const node = byId.get(step.id);
    if (node) node.decisionLabels = new Map(step.decisions.map(decision => [decision.id, decision.label]));
  }

  const labelOf = flow => {
    if (flow.conditionText == null) return flow.name ?? null;
    const decisionId = DECISION_IN_CONDITION.exec(flow.conditionText)?.[1];
    if (decisionId == null) return flow.name ?? null;
    const gateway = byId.get(flow.from);
    const inbound = (incoming.get(gateway?.id ?? "") ?? []).map(candidate => candidate.from);
    const task = inbound.map(sourceId => byId.get(sourceId)).find(node => node?.kind === "task");
    return task?.decisionLabels?.get(decisionId) ?? flow.name ?? null;
  };

  const edges = flows.map(flow => {
    const label = labelOf(flow);
    return { from: flow.from, to: flow.to, ...(label != null ? { label } : {}) };
  });

  // The happy path: from the start event, always follow the first outgoing edge.
  const path = [];
  const visited = new Set();
  let cursor = nodes.find(node => node.kind === "start")?.id ?? "";
  while (cursor && byId.has(cursor) && !visited.has(cursor)) {
    visited.add(cursor);
    path.push(cursor);
    cursor = (outgoing.get(cursor) ?? [])[0]?.to ?? "";
  }

  return {
    nodes: nodes.map(node => ({
      id: node.id,
      name: node.name,
      kind: node.kind,
      ...(node.groups?.length ? { groups: node.groups } : {}),
    })),
    edges,
    path,
  };
}
