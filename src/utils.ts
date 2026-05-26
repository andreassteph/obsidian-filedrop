export function getMonthSlug(): string {
	const d = new Date();
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, '0');
	return `${yyyy}-${mm}`;
}

// "document.pdf" -> "document_pdf"; leaves no-extension names and dotfiles untouched
export function noteNameFromFile(fileName: string): string {
	const lastDot = fileName.lastIndexOf('.');
	if (lastDot <= 0) return fileName;
	return fileName.slice(0, lastDot) + '_' + fileName.slice(lastDot + 1);
}

// "document.pdf", 2 -> "document-2.pdf"; "README", 2 -> "README-2"
export function dedupeName(fileName: string, i: number): string {
	const lastDot = fileName.lastIndexOf('.');
	if (lastDot <= 0) return `${fileName}-${i}`;
	return `${fileName.slice(0, lastDot)}-${i}${fileName.slice(lastDot)}`;
}
