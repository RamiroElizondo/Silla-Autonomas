// Tipos de los imports de imágenes estáticas (`import logo from "./x.png"`).
// Normalmente los trae next-env.d.ts, pero ese archivo lo genera Next y está
// en .gitignore: en CI (`npx tsc --noEmit` sobre un checkout limpio) no existe.
/// <reference types="next/image-types/global" />
