import { Effect, Layer } from "effect";
export const provided = Effect.void.pipe(Effect.provide(Layer.empty));
