/** The fields a canvas search looks at. */
export interface SearchablePaper {
	title: string;
	authors: string[];
}

/** Lowercase and strip accents, so "schrodinger" finds "Schrödinger". */
function fold(text: string): string {
	return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * Whether every word of the query appears in the paper's title or author
 * names. An empty query matches nothing, so an empty search box highlights
 * nothing rather than the whole canvas.
 */
export function matchesPaperQuery(paper: SearchablePaper, query: string): boolean {
	const terms = fold(query).split(/\s+/).filter(Boolean);
	if (terms.length === 0) return false;
	const haystack = fold([paper.title, ...paper.authors].join(" "));
	return terms.every((term) => haystack.includes(term));
}
