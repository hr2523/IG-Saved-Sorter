// Default topic taxonomy. Each category maps to descriptive phrases that CLIP
// scores an image (and caption) against. Users can edit this in Settings; the
// edited copy lives in chrome.storage.local (see settings.js).
//
// Keep each phrase set TIGHT (~3 phrases): the embed engine mean-pools a
// category's phrases into a single prototype vector, so an off-topic phrase
// dilutes it. Bump TAXONOMY_VERSION whenever DEFAULT_CATEGORIES changes so
// existing installs pick up the new taxonomy (see settings.js migration).

export const DEFAULT_CATEGORIES = {
  "Visual Art & Illustration": [
    "a painting or drawing",
    "digital art or an illustration",
    "an artwork on a gallery wall",
  ],
  "Photography": [
    "a fine-art photograph",
    "a professional photography portfolio shot",
    "a black and white artistic photo",
  ],
  "Food & Cooking": [
    "a plate of food",
    "a delicious meal or dish",
    "dessert or baked goods",
  ],
  "Travel & Places": [
    "a travel photo of a famous place",
    "a scenic landscape or destination",
  ],
  "Nature & Animals": [
    "a nature landscape",
    "a wild animal or pet",
  ],
  "Architecture & Interiors": [
    "a building or architecture",
    "interior design of a room",
  ],
  "Fashion & Style": [
    "a fashion outfit",
    "clothing and street style",
  ],
  "Beauty & Makeup": [
    "makeup and cosmetics",
    "a beauty or skincare photo",
  ],
  "Fitness & Sports": [
    "a workout or exercise",
    "a sports activity or athlete",
  ],
  "Music & Concerts": [
    "a musician or band performing",
    "a concert or live music",
  ],
  "Technology & Gadgets": [
    "a physical tech gadget or device",
    "consumer electronics hardware",
  ],
  "Cars & Vehicles": [
    "a car or motorcycle",
    "an automobile or vehicle",
  ],
  "Memes & Humor": [
    "a funny meme with impact-font caption",
    "a reaction image or humorous screenshot",
  ],
  "Quotes & Text": [
    "an inspirational quote in typography on a plain background",
    "a screenshot of a tweet or notes-app text",
  ],
  "People & Portraits": [
    "a studio portrait of a person's face",
    "a posed portrait photograph",
    "a selfie",
  ],
  "Graphic Design & Typography": [
    "graphic design and typography",
    "a poster, logo or branding design",
    "lettering, fonts and type design",
  ],
  "Business & Career": [
    "business, finance or investing",
    "a job posting or hiring announcement",
    "a professional networking or career post",
  ],
  "Books & Education": [
    "books or reading",
    "an educational infographic or study notes",
  ],
  "Motion Graphics & Animation": [
    "a motion graphics animation",
    "an animated title sequence or looping animation",
    "a 2d animated frame or cartoon animation",
  ],
  "3D / CGI Render": [
    "a 3d render or CGI artwork",
    "a computer-generated 3d scene",
    "a 3d rendered product visualization",
  ],
  "Video / Film / Reels": [
    "a cinematic film still",
    "a movie or short film scene",
    "a widescreen video frame with letterboxing",
  ],
  "UI/UX & Web/Product Design": [
    "a user interface or app screen design",
    "a website or web design mockup",
    "a ui/ux product design dashboard",
  ],
  "Tutorials": [
    "a step-by-step tutorial or how-to guide",
    "an instructional diagram with numbered steps",
    "a how-to infographic or tutorial screenshot",
  ],
};

export const UNCATEGORIZED = "Uncategorized";

// Bump whenever DEFAULT_CATEGORIES above changes, so getSettings() refreshes the
// taxonomy frozen in a user's chrome.storage.local (see settings.js).
export const TAXONOMY_VERSION = 2;

// Deep copy. DEFAULT_CATEGORIES is a module singleton also aliased by
// DEFAULT_SETTINGS.categories, so anything that persists/mutates categories must
// clone first (never hand out the shared reference).
export function cloneCategories(src = DEFAULT_CATEGORIES) {
  return JSON.parse(JSON.stringify(src));
}

// Prompt templates for ensembling (mirrors the Python v1).
export const PROMPT_TEMPLATES = [
  "{}",
  "a photo of {}",
  "an instagram post about {}",
];

// Expand a category's phrases through the templates.
export function expandPrompts(phrases, templates = PROMPT_TEMPLATES) {
  const out = [];
  for (const phrase of phrases) {
    for (const t of templates) out.push(t.replace("{}", phrase));
  }
  return out;
}

// Cross-cutting "format/intent" categories that CLIP can't read from pixels — a
// cooking tutorial just looks like food. These are detected from the CAPTION and
// ADDED to a post's categories (multi-label), on top of its visual category.
export const INTENT_DETECTORS = [
  {
    category: "Tutorials",
    re: /(?:#\s*)?\b(tutorials?|how[-\s]?to|step[-\s]?by[-\s]?step|step\s?\d|walkthrough|guide|diy|beginners?|explained|lesson|part\s?\d|ep(?:isode)?\s?\d|recipe|template)\b/i,
  },
  {
    category: "Video / Film / Reels",
    re: /(?:#\s*)?\b(reels?|short\s?film|filmmaking|cinematography|behind\s?the\s?scenes|bts|trailer)\b/i,
  },
];

// Return the intent categories whose caption pattern matches AND that exist in the
// active taxonomy (so a user who removed "Tutorials" never gets a phantom label).
export function detectIntentCategories(caption, allowedNames) {
  if (!caption) return [];
  const allowed = new Set(allowedNames);
  const out = [];
  for (const d of INTENT_DETECTORS) {
    if (allowed.has(d.category) && d.re.test(caption)) out.push(d.category);
  }
  return out;
}
