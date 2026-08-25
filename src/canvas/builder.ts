import type { Paper, CitationEdge, CitationGraph, CanvasData, CanvasEdge } from "../types";
import { layoutPapers, layoutNewPapers, paperNodeId, hasPaperNode, resolvePaperNodeId } from "./layout";

/**
 * Build a complete CanvasData object from a citation graph.
 * Used for initial "Create from Collection".
 */
export function buildCanvas(
  graph: CitationGraph,
  nodeWidth: number,
  nodeHeight: number
): CanvasData {
  const papers = Array.from(graph.papers.values());
  const nodes = layoutPapers(papers, { nodeWidth, nodeHeight });

  // Build a set of valid node IDs for edge validation
  const nodeIds = new Set(nodes.map((n) => n.id));

  // Map S2 IDs to our paper IDs for edge resolution
  const s2ToPaperId = new Map<string, string>();
  for (const paper of papers) {
    if (paper.semanticScholarId) {
      s2ToPaperId.set(paper.semanticScholarId, paper.id);
    }
  }

  const edges: CanvasEdge[] = [];
  const seenEdges = new Set<string>();

  for (const edge of graph.edges) {
    // Resolve S2 IDs to paper IDs, then to node IDs
    const fromPaperId = s2ToPaperId.get(edge.fromId) || edge.fromId;
    const toPaperId = s2ToPaperId.get(edge.toId) || edge.toId;

    const fromPaper = graph.papers.get(fromPaperId);
    const toPaper = graph.papers.get(toPaperId);

    if (!fromPaper || !toPaper) continue;

    const fromNodeId = paperNodeId(fromPaper);
    const toNodeId = paperNodeId(toPaper);

    if (!nodeIds.has(fromNodeId) || !nodeIds.has(toNodeId)) continue;

    const edgeKey = `${fromNodeId}->${toNodeId}`;
    if (seenEdges.has(edgeKey)) continue;
    seenEdges.add(edgeKey);

    edges.push({
      id: `edge-${edgeKey}`,
      fromNode: fromNodeId,
      toNode: toNodeId,
      fromSide: "left",
      toSide: "right",
      toEnd: "arrow",
    });
  }

  return { nodes, edges };
}

/**
 * Add new papers and edges to an existing canvas.
 * Used for "Expand Paper" mode.
 */
export function expandCanvas(
  existingCanvas: CanvasData,
  newPapers: Paper[],
  newEdges: CitationEdge[],
  allPapers: Map<string, Paper>,
  nodeWidth: number,
  nodeHeight: number
): CanvasData {
  // Filter out papers that already have nodes on the canvas
  const existingNodeIds = new Set(existingCanvas.nodes.map((n) => n.id));
  // hasPaperNode, not paperNodeId: a canvas written before the node ID scheme
  // widened stores the legacy ID, and comparing only against the current one
  // would report every paper on it as new and duplicate the whole canvas.
  const trulyNewPapers = newPapers.filter((p) => !hasPaperNode(p, existingNodeIds));

  // Layout new papers (also repositions existing nodes for dense year columns)
  const { updatedExisting, newNodes } = layoutNewPapers(
    existingCanvas.nodes, trulyNewPapers, allPapers, {
      nodeWidth,
      nodeHeight,
    }
  );

  // Build complete node ID set
  const allNodeIds = new Set([
    ...updatedExisting.map((n) => n.id),
    ...newNodes.map((n) => n.id),
  ]);

  // Map S2 IDs → paper node IDs. Resolved against the IDs actually present so
  // an edge endpoint lands on the existing node rather than on a current-scheme
  // ID that no node carries.
  const s2ToNodeId = new Map<string, string>();
  for (const paper of allPapers.values()) {
    const nodeId = resolvePaperNodeId(paper, allNodeIds);
    if (paper.semanticScholarId) {
      s2ToNodeId.set(paper.semanticScholarId, nodeId);
    }
    s2ToNodeId.set(paper.id, nodeId);
  }

  // Add new edges
  const existingEdgeKeys = new Set(
    existingCanvas.edges.map((e) => `${e.fromNode}->${e.toNode}`)
  );

  const addedEdges: CanvasEdge[] = [];
  for (const edge of newEdges) {
    const fromNodeId = s2ToNodeId.get(edge.fromId);
    const toNodeId = s2ToNodeId.get(edge.toId);

    if (!fromNodeId || !toNodeId) continue;
    if (!allNodeIds.has(fromNodeId) || !allNodeIds.has(toNodeId)) continue;

    const edgeKey = `${fromNodeId}->${toNodeId}`;
    if (existingEdgeKeys.has(edgeKey)) continue;
    existingEdgeKeys.add(edgeKey);

    addedEdges.push({
      id: `edge-${edgeKey}`,
      fromNode: fromNodeId,
      toNode: toNodeId,
      fromSide: "left",
      toSide: "right",
      toEnd: "arrow",
    });
  }

  return {
    nodes: [...updatedExisting, ...newNodes],
    edges: [...existingCanvas.edges, ...addedEdges],
  };
}
