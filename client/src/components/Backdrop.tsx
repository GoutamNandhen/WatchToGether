import { lazy, Suspense } from "react";

// three.js is fetched after the page itself renders, so 3D never delays content.
const Backdrop3D = lazy(() => import("./Backdrop3D"));

export default function Backdrop({ density }: { density?: number }) {
  return (
    <Suspense fallback={null}>
      <Backdrop3D density={density} />
    </Suspense>
  );
}
