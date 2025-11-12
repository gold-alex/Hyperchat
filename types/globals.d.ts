// Minimal globals for Chrome extensions when compiling TS
// This avoids adding @types/chrome; WXT provides runtime, but TS needs a hint.
declare const chrome: any;
interface Window { chrome: any }

