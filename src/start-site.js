// Convenience entry point for previewing the public website on localhost:3000.
// The normal API/extension development command keeps using PORT from .env.
process.env.PORT = "3000";
await import("./index.js");
