import { useContext } from "react";
import { AppBridgeContext } from "@shopify/app-bridge-react";
import { authenticatedFetch } from "@shopify/app-bridge-utils";

/**
 * Returns a fetch function that's automatically authenticated with the Shopify app session.
 * Use just like `fetch`.
 */
export function useAuthenticatedFetch() {
  const app = useContext(AppBridgeContext);

  return (uri, options) => {
    return authenticatedFetch(app)(uri, options);
  };
}
