// No profanity in what Jarvis is asked to say to drivers (Nov 22, 2026 — the AI call's custom question). English and Spanish
// swear words and slurs, matched as whole words, also when spelled with symbols or repeated letters ("f*ck", "fuuuck", "sh1t").
// Pure. The list is short on purpose: it catches what a dispatcher might type in anger, not every possible word.
const WORDS = [
  'fuck', 'fucking', 'fucker', 'fucked', 'motherfucker', 'shit', 'shitty', 'bullshit', 'bitch', 'bitches', 'bastard', 'asshole', 'ass', 'dick', 'dickhead',
  'cunt', 'pussy', 'cock', 'damn', 'goddamn', 'crap', 'piss', 'pissed', 'slut', 'whore', 'retard', 'retarded', 'idiot', 'stupid', 'moron', 'dumbass', 'jackass',
  'nigger', 'nigga', 'faggot', 'fag', 'spic', 'wetback',
  'mierda', 'puta', 'puto', 'putas', 'putos', 'pendejo', 'pendeja', 'pendejos', 'cabron', 'cabrona', 'cabrones', 'chingar', 'chinga', 'chingada', 'chingado',
  'verga', 'coño', 'cono', 'carajo', 'joder', 'jodido', 'jodete', 'culero', 'culo', 'marica', 'maricon', 'mamon', 'mamaguevo', 'malparido', 'hijueputa', 'gonorrea',
  'hijo de puta', 'idiota', 'estupido', 'estupida', 'imbecil', 'huevon', 'guevon', 'guevón',
];
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i' };
// the words in a text, lowercased, accents off, symbols-as-letters undone, "f*ck" → "fck" and runs of a letter squeezed
export function words(text) {
  const t = String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[0134578@$!]/g, (c) => LEET[c] || c).replace(/[*#%^&_.\-]+/g, '').replace(/(\w)\1{2,}/g, '$1$1');
  return t.split(/[^a-zñ]+/).filter(Boolean);
}
const SET = new Set(WORDS.filter((w) => !w.includes(' ')).map((w) => w.normalize('NFD').replace(/[̀-ͯ]/g, '')));
const squeeze = (w) => w.replace(/(\w)\1+/g, '$1');
const SQUEEZED = new Set([...SET].map(squeeze));
const STARRED = new Set([...SET].map((w) => w.replace(/[aeiou]/g, '')).filter((w) => w.length >= 3));   // "f*ck" / "sh*t" → "fck" / "sht"
// → the bad words found ([] = clean)
export function profanity(text) {
  const ws = words(text);
  const hits = ws.filter((w) => SET.has(w) || SQUEEZED.has(squeeze(w)) || (STARRED.has(w) && !/[aeiou]/.test(w)));
  if (/\bhijo\s+de\s+puta\b/i.test(String(text || ''))) hits.push('hijo de puta');
  return [...new Set(hits)];
}
