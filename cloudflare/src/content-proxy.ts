// The content origin Worker: forwards every request, unchanged, to the 9artifacts
// Worker, which recognises this host and serves only sandboxed content on it.
interface ProxyEnv {
  APP: Fetcher;
}

export default {
  fetch(request: Request, env: ProxyEnv): Promise<Response> {
    return env.APP.fetch(request);
  },
} satisfies ExportedHandler<ProxyEnv>;
