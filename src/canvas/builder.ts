import type { Paper, CitationEdge, CitationGraph, CanvasData, CanvasEdge } from "../types";
import { logOnly } from "../log";
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

  const addedEdges = resolveNewEdges(
    existingCanvas.edges,
    allNodeIds,
    newEdges,
    allPapers
  );

  return {
    nodes: [...updatedExisting, ...newNodes],
    edges: [...existingCanvas.edges, ...addedEdges],
  };
}

/**
 * Turn citation edges into canvas edges against a fixed set of nodes, dropping
 * the ones already drawn and the ones whose endpoints are not on the canvas.
 *
 * Kept separate from `expandCanvas` because an edges-only sync must leave the
 * nodes untouched: `layoutNewPapers` rebuilds the whole year layout, which
 * would throw away every hand-placed position, and losing manual positioning
 * is what *Canvas: relayout* asks for confirmation before doing.
 */
export function resolveNewEdges(
  existingEdges: CanvasEdge[],
  nodeIds: Set<string>,
  newEdges: CitationEdge[],
  allPapers: Map<string, Paper>
): CanvasEdge[] {
  // Map paper identifiers → paper node IDs. Resolved against the IDs actually
  // present so an edge endpoint lands on the existing node rather than on a
  // current-scheme ID that no node carries.
  const idToNodeId = new Map<string, string>();
  for (const paper of allPapers.values()) {
    const nodeId = resolvePaperNodeId(paper, nodeIds);
    if (paper.semanticScholarId) {
      idToNodeId.set(paper.semanticScholarId, nodeId);
    }
    idToNodeId.set(paper.id, nodeId);
  }

  const seenEdgeKeys = new Set(
    existingEdges.map((e) => `${e.fromNode}->${e.toNode}`)
  );

  const addedEdges: CanvasEdge[] = [];
  for (const edge of newEdges) {
    const fromNodeId = idToNodeId.get(edge.fromId);
    const toNodeId = idToNodeId.get(edge.toId);

    // An endpoint naming an identifier no paper is indexed under means the
    // caller built the edge from a different id scheme than the papers it
    // passed. The arrow just goes missing on the canvas, so say so in the log
    // rather than dropping it in silence.
    if (!fromNodeId || !toNodeId) {
      logOnly(
        `Dropped citation edge ${edge.fromId} -> ${edge.toId}: ` +
          `${!fromNodeId ? "source" : "target"} paper is not on the canvas.`
      );
      continue;
    }
    if (!nodeIds.has(fromNodeId) || !nodeIds.has(toNodeId)) {
      logOnly(
        `Dropped citation edge ${edge.fromId} -> ${edge.toId}: ` +
          `resolved to node id not present on the canvas.`
      );
      continue;
    }

    const edgeKey = `${fromNodeId}->${toNodeId}`;
    if (seenEdgeKeys.has(edgeKey)) continue;
    seenEdgeKeys.add(edgeKey);

    addedEdges.push({
      id: `edge-${edgeKey}`,
      fromNode: fromNodeId,
      toNode: toNodeId,
      fromSide: "left",
      toSide: "right",
      toEnd: "arrow",
    });
  }

  return addedEdges;
}
