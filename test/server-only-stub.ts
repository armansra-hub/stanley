// "server-only" is a build-time guard with no runtime behaviour. Vitest can't resolve
// it, which made every server module untestable — including the news relevance gate
// that was scoring month names as company matches. Aliased to this no-op so the pure
// logic inside those modules can be unit tested.
export {};
