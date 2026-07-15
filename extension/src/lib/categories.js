// Default topic taxonomy. Each category maps to descriptive phrases that CLIP
// scores an image (and caption) against. Users can edit this in Settings; the
// edited copy lives in chrome.storage.local (see settings.js).

export const DEFAULT_CATEGORIES = {
  "Visual Art & Illustration": [
    "a painting or drawing",
    "digital art or an illustration",
    "an artwork on a gallery wall",
  ],
  "Photography": [
    "an artistic photograph",
    "a striking photography shot",
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
    "a computer, phone or gadget",
    "technology and electronics",
  ],
  "Cars & Vehicles": [
    "a car or motorcycle",
    "an automobile or vehicle",
  ],
  "Memes & Humor": [
    "a funny meme",
    "a humorous image with text overlay",
  ],
  "Quotes & Text": [
    "an inspirational quote on a plain background",
    "a screenshot of text or a tweet",
  ],
  "People & Portraits": [
    "a portrait of a person",
    "a selfie or photo of people",
  ],
  "Graphic Design & Typography": [
    "graphic design and typography",
    "a poster, logo or branding design",
    "lettering, fonts and type design",
  ],
  "Business & Career": [
    "business, finance or investing",
    "a job, hiring or career opportunity post",
    "an advertisement or marketing promotion",
  ],
  "Books & Education": [
    "books or reading",
    "an educational infographic or study notes",
  ],
};

export const UNCATEGORIZED = "Uncategorized";

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
