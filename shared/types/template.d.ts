/**
 * A resume template as stored in backend/data/templates/<id>.json.
 *
 * `htmlContent` is a Handlebars template rendered against the resume render data; a
 * template built in the manual editor also keeps the config it was generated from, so it
 * can be reopened and edited rather than only regenerated.
 */

export interface ManualTemplateStyle {
  color?: string;
  fontSizePt?: number;
  fontFamily?: string;
  fontWeight?: string;
}

export interface ManualTemplateConfigStored {
  name: string;
  description?: string;
  columns: 1 | 2;
  accentColor?: string;
  bodyColor?: string;
  bodyFontSizePt?: number;
  titleFontSizePt?: number;
  sectionOrder?: string[];
  leftSectionOrder?: string[];
  rightSectionOrder?: string[];
  nameStyle?: ManualTemplateStyle;
  headerTitleStyle?: ManualTemplateStyle;
  contactStyle?: ManualTemplateStyle;
  titleStyle?: ManualTemplateStyle;
  subTitleStyle?: ManualTemplateStyle;
  paragraphStyle?: ManualTemplateStyle;
  sectionStyles?: Record<string, Record<string, ManualTemplateStyle>>;
}

export interface Template {
  id: string;
  name: string;
  description: string;
  disabled?: boolean;
  htmlContent: string;
  cssContent: string;
  sections: string[];
  createdAt: string;
  updatedAt: string;
  manualConfig?: ManualTemplateConfigStored;
}

export interface CreateTemplateDTO {
  name: string;
  description?: string;
}
