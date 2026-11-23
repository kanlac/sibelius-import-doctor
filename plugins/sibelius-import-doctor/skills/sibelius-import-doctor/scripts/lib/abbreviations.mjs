// Short instrument names for parts that have none (Sibelius shows these at the start of
// every system after the first).

// Chinese instrument names, checked first and in this order (a longer name before any
// shorter name it contains). Kept exactly as in the Python prototype so results match it.
const CHINESE = [
  ["低音提琴", "Cb."], // double bass
  ["大提琴", "Vc."], // cello
  ["中提琴", "Vla."], // viola
  ["小提琴", "Vln."], // violin
  ["低音单簧管", "B. Cl."], // bass clarinet
  ["单簧管", "Cl."], // clarinet
  ["双簧管", "Ob."], // oboe
  ["英国管", "E. Hn."], // English horn
  ["短笛", "Picc."], // piccolo
  ["长笛", "Fl."], // flute
  ["低音大管", "Cbsn."], // contrabassoon
  ["大管", "Bsn."], // bassoon
  ["圆号", "Hn."], // horn
  ["小号", "Tpt."], // trumpet
  ["长号", "Tbn."], // trombone
  ["大号", "Tba."], // tuba
  ["定音鼓", "Timp."], // timpani
  ["打击乐器", "Perc."], // percussion
  ["康加鼓", "Cga."], // conga
  ["吊鈸", "Sus. Cym."], // suspended cymbal (traditional characters)
  ["吊镲", "Sus. Cym."], // suspended cymbal
  ["管钟", "Tub. B."], // tubular bells
  ["钢片琴", "Cel."], // celesta
  ["马林巴琴", "Mar."], // marimba
  ["马林巴", "Mar."], // marimba
  ["颤音琴", "Vib."], // vibraphone
  ["钟琴", "Glock."], // glockenspiel
  ["木琴", "Xyl."], // xylophone
  ["竖琴", "Hp."], // harp
  ["钢琴", "Pno."], // piano
  ["管风琴", "Org."], // organ
];

// English (and common Italian) names, matched as whole words, case-insensitively,
// longest name first.
const ENGLISH = [
  ["piccolo", "Picc."], ["alto flute", "A. Fl."], ["bass flute", "B. Fl."], ["flute", "Fl."],
  ["oboe d'amore", "Ob. d'am."], ["oboe", "Ob."], ["english horn", "E. Hn."], ["cor anglais", "C. A."],
  ["bass clarinet", "B. Cl."], ["contrabass clarinet", "Cb. Cl."], ["clarinet", "Cl."],
  ["contrabassoon", "Cbsn."], ["bassoon", "Bsn."],
  ["soprano saxophone", "S. Sax."], ["alto saxophone", "A. Sax."], ["tenor saxophone", "T. Sax."],
  ["baritone saxophone", "Bar. Sax."], ["saxophone", "Sax."],
  ["french horn", "Hn."], ["horn", "Hn."], ["trumpet", "Tpt."], ["cornet", "Cor."], ["flugelhorn", "Flgh."],
  ["bass trombone", "B. Tbn."], ["trombone", "Tbn."], ["euphonium", "Euph."], ["tuba", "Tba."],
  ["timpani", "Timp."], ["percussion", "Perc."], ["drum set", "Dr."], ["drum kit", "Dr."], ["drums", "Dr."],
  ["snare drum", "S. D."], ["bass drum", "B. D."], ["suspended cymbal", "Sus. Cym."], ["cymbals", "Cym."],
  ["triangle", "Tri."], ["tambourine", "Tamb."], ["tubular bells", "Tub. B."], ["chimes", "Chm."],
  ["glockenspiel", "Glock."], ["xylophone", "Xyl."], ["vibraphone", "Vib."], ["marimba", "Mar."],
  ["celesta", "Cel."], ["harp", "Hp."], ["piano", "Pno."], ["pianoforte", "Pno."], ["harpsichord", "Hpd."],
  ["organ", "Org."], ["accordion", "Acc."], ["electric guitar", "E. Gtr."], ["bass guitar", "B. Gtr."],
  ["acoustic guitar", "A. Gtr."], ["guitar", "Gtr."], ["mandolin", "Mand."],
  ["soprano", "S."], ["mezzo-soprano", "Mez."], ["alto", "A."], ["contralto", "A."], ["tenor", "T."],
  ["baritone", "Bar."], ["bass", "B."], ["voice", "V."],
  ["violin", "Vln."], ["violino", "Vln."], ["viola", "Vla."], ["violoncello", "Vc."], ["cello", "Vc."],
  ["double bass", "Cb."], ["contrabass", "Cb."], ["string bass", "Cb."],
].sort((a, b) => b[0].length - a[0].length);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ENGLISH_RE = ENGLISH.map(([k, v]) => [new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(k)}(?![\\p{L}\\p{N}])`, "iu"), v]);

const TRAILING_NUMBER = /(\p{Nd}+(?:[.,]\p{Nd}+)?)\s*$/u;

/** Abbreviation for a part name: known instruments map to standard short names; a trailing
 *  player number is kept ("Violin 2" -> "Vln. 2"); anything else becomes its first four
 *  letters plus a period. Returns "" for an empty name. */
export function abbreviate(name) {
  const digits = name.match(TRAILING_NUMBER);
  const num = digits ? ` ${digits[1]}` : "";
  for (const [k, v] of CHINESE) if (name.includes(k)) return v + num;
  for (const [re, v] of ENGLISH_RE) if (re.test(name)) return v + num;
  const stem = name.replace(/\s*\p{Nd}+(?:[.,]\p{Nd}+)?\s*$/u, "").trim();
  return stem ? Array.from(stem).slice(0, 4).join("") + "." + num : "";
}
