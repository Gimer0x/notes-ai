export type LegalSection = {
  title: string;
  paragraphs: string[];
  bullets?: string[];
};

export type LegalDoc = {
  title: string;
  updated: string;
  intro: string[];
  sections: LegalSection[];
};
