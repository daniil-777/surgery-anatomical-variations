// The Supabase backend (see supabaseBackend.ts). Import this module lazily: it pulls in supabase-js.
export { SupabaseBackend, type SupabaseBackendDeps, type SupabaseClientFactory } from "./supabaseBackend";
export { AUTH_STORAGE_KEY, FRESH_SIGN_IN_SECONDS, MIN_PASSWORD_LENGTH, SupabaseAuth, jwtClaims, lastSignInAt, mapSession, mapUser, userProviders } from "./auth";
export { SupabaseTransport, USER_CONTENT_BUCKET } from "./transport";
export * from "./mappers";
