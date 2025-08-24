// Wrapper to make protobufjs/minimal.js work as an ES6 module
import './protobufjs/minimal.js';

// After loading the UMD module, protobuf should be available globally
const $protobuf = window.protobuf || self.protobuf;

if (!$protobuf) {
  throw new Error('Failed to load protobuf library');
}

// Export everything that chat-message.js needs
export const Reader = $protobuf.Reader;
export const Writer = $protobuf.Writer; 
export const util = $protobuf.util;
export const roots = $protobuf.roots || {};

// Ensure roots["default"] exists
if (!$protobuf.roots) {
  $protobuf.roots = {};
}
if (!$protobuf.roots["default"]) {
  $protobuf.roots["default"] = {};
}

// Export the main protobuf object as default
export default $protobuf;

// Also export as a named export for compatibility
export { $protobuf };