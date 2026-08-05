import { createServerFn } from "@tanstack/react-start";
import { fetchPrStatus, staticPrStatus } from "@kanbanly/core";

export const getPrStatusFn = createServerFn({ method: "GET" })
  .inputValidator((d: { pr: string }) => d)
  .handler(async ({ data }) => {
    return fetchPrStatus(data.pr);
  });

export async function getPrStatusService(pr: string) {
  return fetchPrStatus(pr);
}

export { staticPrStatus };
