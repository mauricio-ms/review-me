import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

const c = {
  fg: "#e4e4ef",
  fg1: "#f4f4ff",
  fg2: "#f5f5f5",
  white: "#ffffff",
  black: "#000000",
  bgMinus1: "#101010",
  bg: "#181818",
  bg1: "#282828",
  bg2: "#453d41",
  bg3: "#484848",
  bg4: "#52494e",
  redMinus1: "#c73c3f",
  red: "#f43841",
  red1: "#ff4f58",
  green: "#73c936",
  yellow: "#ffdd33",
  brown: "#cc8c3c",
  quartz: "#95a99f",
  niagara2: "#303540",
  niagara1: "#565f73",
  niagara: "#96a6c8",
  wisteria: "#9e95c7",
} as const;

const gruberDarkerEditorTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: c.bg,
      color: c.fg,
    },
    ".cm-scroller": {
      backgroundColor: c.bg,
    },
    ".cm-content": {
      caretColor: c.yellow,
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: c.yellow,
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      {
        backgroundColor: c.bg3,
      },
    ".cm-activeLine": {
      backgroundColor: c.bg1,
    },
    ".cm-gutters": {
      backgroundColor: c.bg,
      borderRight: `1px solid ${c.bg2}`,
      color: c.bg4,
    },
    ".cm-activeLineGutter": {
      backgroundColor: c.bg1,
      color: c.yellow,
    },
    ".cm-matchingBracket": {
      backgroundColor: c.bg4,
      color: c.fg2,
    },
    ".cm-nonmatchingBracket": {
      backgroundColor: c.redMinus1,
      color: c.white,
    },
    ".cm-searchMatch": {
      backgroundColor: c.niagara2,
      outline: `1px solid ${c.niagara1}`,
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: c.bg4,
    },
    ".cm-selectionMatch": {
      backgroundColor: c.bg2,
    },
    ".cm-occurrence": {
      backgroundColor: c.niagara2,
      boxShadow: `inset 0 -1px ${c.niagara1}`,
    },
    // Swiper: every match in view, the selected line, and the matches on it.
    ".cm-line.cm-swiper-line": {
      backgroundColor: c.bg2,
    },
    ".cm-swiper-match": {
      backgroundColor: c.bg4,
      boxShadow: `inset 0 -1px ${c.brown}`,
    },
    ".cm-swiper-current, .cm-swiper-current *": {
      backgroundColor: c.yellow,
      color: c.black,
    },
    ".cm-panels": {
      backgroundColor: c.bgMinus1,
      color: c.fg,
    },
    ".cm-panels.cm-panels-top": {
      borderBottom: `1px solid ${c.bg2}`,
    },
    ".cm-panels.cm-panels-bottom": {
      borderTop: `1px solid ${c.bg2}`,
    },
    ".cm-panel input": {
      backgroundColor: c.bg1,
      color: c.fg,
    },
    ".cm-tooltip": {
      backgroundColor: c.bg1,
      border: `1px solid ${c.bg3}`,
      color: c.fg,
    },
    ".cm-tooltip-autocomplete ul li[aria-selected]": {
      backgroundColor: c.bg2,
      color: c.fg2,
    },
  },
  { dark: true },
);

const gruberDarkerHighlightStyle = HighlightStyle.define([
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: c.brown },
  { tag: tags.docComment, color: c.green },
  {
    tag: [
      tags.keyword,
      tags.definitionKeyword,
      tags.modifier,
      tags.operatorKeyword,
      tags.controlKeyword,
      tags.moduleKeyword,
    ],
    color: c.yellow,
    fontWeight: "bold",
  },
  { tag: [tags.atom, tags.bool, tags.null, tags.unit], color: c.quartz },
  { tag: [tags.number, tags.integer, tags.float], color: c.wisteria },
  {
    tag: [tags.string, tags.docString, tags.character, tags.attributeValue],
    color: c.green,
  },
  { tag: [tags.regexp, tags.escape, tags.special(tags.string)], color: c.green },
  {
    tag: [
      tags.function(tags.variableName),
      tags.function(tags.propertyName),
      tags.definition(tags.function(tags.variableName)),
      tags.definition(tags.function(tags.propertyName)),
    ],
    color: c.niagara,
  },
  {
    tag: [tags.typeName, tags.className, tags.namespace, tags.macroName],
    color: c.quartz,
  },
  {
    tag: [
      tags.constant(tags.name),
      tags.constant(tags.variableName),
      tags.standard(tags.name),
    ],
    color: c.quartz,
  },
  {
    tag: [
      tags.variableName,
      tags.definition(tags.variableName),
      tags.propertyName,
      tags.attributeName,
      tags.labelName,
    ],
    color: c.fg1,
  },
  {
    tag: [tags.meta, tags.documentMeta, tags.annotation, tags.processingInstruction],
    color: c.quartz,
  },
  {
    tag: [
      tags.operator,
      tags.derefOperator,
      tags.arithmeticOperator,
      tags.logicOperator,
      tags.bitwiseOperator,
      tags.compareOperator,
      tags.updateOperator,
      tags.definitionOperator,
      tags.typeOperator,
      tags.controlOperator,
    ],
    color: c.fg,
  },
  {
    tag: [
      tags.punctuation,
      tags.separator,
      tags.bracket,
      tags.angleBracket,
      tags.squareBracket,
      tags.paren,
      tags.brace,
    ],
    color: c.fg,
  },
  { tag: tags.heading, color: c.yellow, fontWeight: "bold" },
  { tag: tags.link, color: c.niagara, textDecoration: "underline" },
  { tag: tags.monospace, color: c.quartz },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.inserted, color: c.green },
  { tag: tags.deleted, color: c.red1 },
  { tag: tags.changed, color: c.brown },
  { tag: tags.invalid, color: c.red, textDecoration: "underline" },
]);

export const gruberDarkerTheme: Extension = [
  gruberDarkerEditorTheme,
  syntaxHighlighting(gruberDarkerHighlightStyle),
];
