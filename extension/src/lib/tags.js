// Vocabulary of short descriptive tags scored against each image by CLIP to
// produce per-post keywords, plus a lightweight caption keyword extractor.

export const TAG_VOCAB = [
  // food
  "food", "coffee", "dessert", "baking", "recipe", "restaurant", "cocktail", "brunch",
  // places / travel
  "travel", "beach", "mountains", "city", "street", "architecture", "interior design", "hotel", "nature", "landscape", "sunset",
  // nature / animals
  "flowers", "plants", "forest", "ocean", "animal", "dog", "cat", "wildlife",
  // people / style
  "portrait", "selfie", "fashion", "outfit", "streetwear", "runway", "makeup", "hairstyle", "jewelry", "tattoo",
  // art
  "painting", "illustration", "sculpture", "drawing", "sketch", "graffiti", "digital art", "collage", "printmaking", "ceramics",
  // design / typography
  "graphic design", "typography", "poster", "logo", "branding", "layout", "editorial design", "3d render", "motion graphics", "album cover", "packaging",
  // music
  "music", "concert", "band", "guitar", "piano", "dj", "vinyl record",
  // tech
  "technology", "gadget", "smartphone", "laptop", "coding", "software", "artificial intelligence", "robotics",
  // vehicles
  "car", "sports car", "motorcycle", "bicycle", "aircraft",
  // fitness / sports
  "fitness", "gym workout", "running", "yoga", "basketball", "soccer", "climbing", "skateboarding",
  // humor / text
  "meme", "funny", "quote", "text graphic", "infographic", "screenshot", "chart",
  // business
  "business", "startup", "marketing", "finance", "money", "career", "advertisement", "productivity",
  // home
  "home decor", "furniture", "kitchen", "workspace", "plants at home",
  // photography styles
  "black and white photography", "film photography", "aesthetic", "minimalism", "vintage",
  // misc creative
  "animation", "comic", "fantasy art", "science", "space", "fashion editorial",
];

const STOPWORDS = new Set(
  ("a an the and or but if then so of to in on at for with without from by as is are was were be been being this that these those " +
    "it its it's i you he she they we me my your our their his her them us not no yes do does did done will would can could should " +
    "just about into over under more most very really out up down off again new get got like via im i'm you're dont don't " +
    "one two three all any some how what when where who why which here there now today").split(/\s+/)
);

export function extractCaptionKeywords(caption, max = 5) {
  if (!caption) return [];
  const out = [];
  const seen = new Set();
  // hashtags first
  for (const m of caption.matchAll(/#(\w{2,30})/g)) {
    const w = m[1].toLowerCase();
    if (!seen.has(w)) { seen.add(w); out.push(w); }
  }
  // then salient plain words
  for (const raw of caption.toLowerCase().replace(/https?:\/\/\S+/g, " ").split(/[^a-z0-9']+/)) {
    const w = raw.trim();
    if (w.length < 3 || w.length > 24) continue;
    if (STOPWORDS.has(w) || /^\d+$/.test(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= max * 2) break;
  }
  return out.slice(0, max);
}
