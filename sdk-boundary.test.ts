import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";

describe("public SDK boundary", () => {
  it("uses only public SDK and declared package imports", () => {
    const scan = experimental_scanPublicSdkOnly(".", {
      allow: [
        /^@\//,
        /^@hugeicons\//,
        /^@radix-ui\//,
        /^@tanstack\//,
        /^@testing-library\//,
        /^class-variance-authority$/,
        /^clsx$/,
        /^react(?:-dom)?(?:\/.*)?$/,
        /^sonner$/,
        /^tailwind-merge$/,
        /^vitest$/,
      ],
    });

    expect(scan.violations).toEqual([]);
    expect(scan.privateDependencies).toEqual([]);
  });
});
