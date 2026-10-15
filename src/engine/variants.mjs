// Search-query variants for one track.
//
// The old buildSearchVariants produced four strings that were IDENTICAL after
// dedup for any single-artist title without parentheses - "Fetish"/"Obzkure"
// collapsed to just ["Fetish Obzkure"]. tryNextSearchVariant therefore returned
// false on the first call, so the "retry with a different query" safety net
// never once fired for the majority of a playlist. Every variant below is
// constructed to differ STRUCTURALLY, not just cosmetically, so the list is
// genuinely more than one entry for ordinary tracks.

const CREDIT_PAREN = /\s*[([]\s*(?:feat\.?|featuring|with)\b[^)\]]*[)\]]/gi;
// A trailing edit/version marker: "(Slowed)", "- Radio Edit". Dropping it
// widens the search, and the scorer's ALTERING gate still refuses a hit whose
// cut does not match, so this cannot silently fetch the wrong recording.
const TRAILING_MARKER = /\s*[([][^)\]]*[)\]]\s*$|\s+-\s+[^-]+$/;

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const broadQueryTitle = (s) => clean(String(s || '').replace(/['‘’]/g, '').replace(/[()[\],.!?"“”]+/g, ' '));

export function primaryArtist(artist) {
  return clean(String(artist || '').split(/(?:[,&;]|\s+[/x]\s+|\s+(?:feat\.?|ft\.?|featuring|with|vs\.?)\s+)/i)[0]);
}

// The single best-guess query, used for display and as the report's searchQuery.
export function buildSearchQuery(title, artist) {
  const t = clean(String(title || '').replace(CREDIT_PAREN, '').replace(/[()[\]]/g, ' '));
  return clean(`${t} ${primaryArtist(artist)}`);
}

export function buildSearchVariants(title, artist, album) {
  const exact = clean(String(title || '').replace(CREDIT_PAREN, ''));
  const all = clean(artist);
  const primary = primaryArtist(artist);
  const flattened = broadQueryTitle(exact);
  const stripped = broadQueryTitle(exact.replace(TRAILING_MARKER, ''));

  const out = [
    [exact, all].filter(Boolean).join(' '),           // full credits
    [exact, primary].filter(Boolean).join(' '),       // lead artist only
    [stripped, primary].filter(Boolean).join(' '),    // broaden before the cap cuts off fallbacks
    [flattened, primary].filter(Boolean).join(' '),   // punctuation flattened
    [exact, primary, album || ''].filter(Boolean).join(' '), // disambiguate by album
    // Title alone still retains the original recording metadata for scoring.
    exact,                                            // title alone; the scorer still
                                                      // enforces the artist match, so a
                                                      // wrong-artist hit is rejected, but
                                                      // this rescues tracks whose artist
                                                      // is spelled differently upstream
  ];
  return out.filter((q, i, list) => q && list.indexOf(q) === i);
}
