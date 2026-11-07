async function searchLyrics(query) {
    if (!query) throw new Error('Query parameter is required');

    const res = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(query)}`, {
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(30000)
    });

    if (!res.ok) throw new Error(`Failed to fetch lyrics (Status ${res.status})`);

    return await res.json();
}

export { searchLyrics }
