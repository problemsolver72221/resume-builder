import { createRandom } from '../utils/seededRandom';

/**
 * Makes every cover letter different, in wording and on the page.
 *
 * The old letters all read the same because the prompt dictated the shape: four
 * paragraphs opening "I've spent the last…", "In my role at X, I…", "I'm also proud of…".
 * The facts varied, the skeleton never did. Variation therefore has to come from the
 * instructions, not from sampling temperature — the tailoring call runs at 0.2 so the
 * resume's facts stay tight, and a different recipe per call is what actually changes the
 * letter. The pools below give 3 x 8 x 6 x 6 x 5 = 4,320 distinct briefs.
 *
 * One recipe and one visual style are drawn per generation and used for every artifact of
 * that application, so the PDF and the DOCX never disagree.
 */

const PARAGRAPH_COUNTS = [2, 3, 4] as const;

const OPENINGS = [
  'Open mid-thought, as if continuing a conversation already underway.',
  'Open on a concrete scene from the candidate\'s work: a specific moment, place, or problem.',
  'Open with a blunt, declarative claim about what the candidate is good at, then justify it.',
  'Open with the single number or outcome the candidate is proudest of, then explain it.',
  'Open with a question the candidate finds genuinely interesting about this kind of work.',
  'Open on a contrast: something widely assumed about this work versus what the candidate has found true.',
  'Open with what first drew the candidate to this field, kept brief and unsentimental.',
  'Open by naming the specific problem this role exists to solve, then connect to relevant experience.',
] as const;

const RHYTHMS = [
  'Open with a sentence under 8 words.',
  'Use one long, winding sentence followed by two short ones.',
  'Keep every sentence under 20 words.',
  'Let one paragraph be a single sentence.',
  'Vary sentence length sharply: no two consecutive sentences within 5 words of each other.',
  'Build each paragraph from short sentences to a longer closing one.',
] as const;

const CLOSINGS = [
  'Close on a concrete detail, not a summary.',
  'Close with a short sentence, six words or fewer.',
  'Close by naming something specific the candidate wants to work on next.',
  'Close on an understated line that resists selling.',
  'Close by returning to an image or idea from the opening paragraph.',
  'Close with a plain statement of what the candidate would bring, no flourish.',
] as const;

const REGISTERS = [
  'Register: dry and understated. Let the work speak; no enthusiasm words.',
  'Register: warm and direct, like explaining your work to a respected colleague.',
  'Register: plain and matter-of-fact, closer to an engineer\'s notes than a pitch.',
  'Register: reflective, willing to mention what was hard or what was learned.',
  'Register: confident and brisk, economical with words.',
] as const;

/** Core fonts, so Word renders the DOCX the same way Chrome renders the PDF. */
const FONTS = [
  { css: 'Georgia, serif', docx: 'Georgia' },
  { css: 'Garamond, serif', docx: 'Garamond' },
  { css: 'Cambria, serif', docx: 'Cambria' },
  { css: '"Book Antiqua", Palatino, serif', docx: 'Book Antiqua' },
  { css: 'Calibri, sans-serif', docx: 'Calibri' },
  { css: 'Arial, sans-serif', docx: 'Arial' },
  { css: '"Trebuchet MS", sans-serif', docx: 'Trebuchet MS' },
  { css: 'Verdana, sans-serif', docx: 'Verdana' },
] as const;

/**
 * Dark enough to stay legible on white and to survive greyscale printing and ATS text
 * extraction. Brighter values would read as unprofessional on a job application.
 */
const COLORS = [
  { name: 'black', hex: '#1A1A1A' },
  { name: 'charcoal', hex: '#333333' },
  { name: 'navy', hex: '#1A3A6B' },
  { name: 'blue', hex: '#1F4E9C' },
  { name: 'teal', hex: '#125F63' },
  { name: 'forest green', hex: '#1A5632' },
  { name: 'green', hex: '#2E6B2E' },
  { name: 'burgundy', hex: '#7A1F2B' },
  { name: 'red', hex: '#9B1C1C' },
  { name: 'plum', hex: '#5B2A6B' },
  { name: 'brown', hex: '#5C4033' },
] as const;

const GREETINGS = [
  'Dear Hiring Manager,',
  'Dear Hiring Team,',
  'Hello,',
  'Dear Recruiting Team,',
  'To the Hiring Team,',
] as const;

const SIGN_OFFS = ['Best regards,', 'Kind regards,', 'Sincerely,', 'All the best,', 'Warm regards,'] as const;

/** Which part, if any, is set in italics. */
const ITALIC_TARGETS = ['none', 'none', 'none', 'greeting', 'signoff', 'closing-paragraph'] as const;

export type ItalicTarget = (typeof ITALIC_TARGETS)[number];

export interface CoverLetterStyle {
  fontCss: string;
  fontDocx: string;
  colorName: string;
  colorHex: string;
  fontSizePt: number;
  lineHeight: number;
  greeting: string;
  signOff: string;
  italic: ItalicTarget;
}

export interface CoverLetterVariation {
  /** Echoed back so a letter someone liked can be reproduced exactly. */
  seed: number;
  paragraphCount: number;
  /** Instruction block appended to the prompt's volatile tail. */
  recipe: string;
  style: CoverLetterStyle;
}


function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)];
}

/**
 * Substituted for the recipe when the letter is switched off. It lands in the prompt's
 * volatile tail — the last thing the model reads — so it overrides the letter rules in the
 * cached prefix without forking the template, which would cost a second cache entry.
 * The letter is ~750 output tokens, the most expensive tokens in the call.
 */
export const OMIT_COVER_LETTER_RECIPE = [
  'DO NOT write a cover letter for this request. This overrides every cover letter rule above.',
  'Set "coverLetter" to an empty string ("") and write nothing else for that field.',
  'Every other field is still required in full.',
].join('\n');

export function createCoverLetterVariation(seed = Math.floor(Math.random() * 0xffffffff)): CoverLetterVariation {
  const random = createRandom(seed);

  const paragraphCount = pick(random, PARAGRAPH_COUNTS);
  const font = pick(random, FONTS);
  const color = pick(random, COLORS);

  const recipe = [
    `Write the cover letter to this brief, which applies only to this letter:`,
    `- Exactly ${paragraphCount} paragraphs.`,
    `- ${pick(random, OPENINGS)}`,
    `- ${pick(random, RHYTHMS)}`,
    `- ${pick(random, CLOSINGS)}`,
    `- ${pick(random, REGISTERS)}`,
    `- Do not begin two paragraphs with the same construction.`,
    `- Do not use the phrases "I've spent the last", "In my role at", or "I'm also proud of".`,
  ].join('\n');

  return {
    seed,
    paragraphCount,
    recipe,
    style: {
      fontCss: font.css,
      fontDocx: font.docx,
      colorName: color.name,
      colorHex: color.hex,
      fontSizePt: pick(random, [10.5, 11, 11, 11.5]),
      lineHeight: pick(random, [1.4, 1.45, 1.5, 1.55, 1.6]),
      greeting: pick(random, GREETINGS),
      signOff: pick(random, SIGN_OFFS),
      italic: pick(random, ITALIC_TARGETS),
    },
  };
}
