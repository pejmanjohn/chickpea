export default {
  async fetch(request: Request): Promise<Response> {
    const { Composio } = await import('@composio/core');
    const { COMPOSIO_TOOLKIT_VERSIONS } = await import(
      '../../../src/connections/providers/composio/versions.ts'
    );
    const backendUrl = new URL(request.url).searchParams.get('backend_url');
    if (!backendUrl?.startsWith('http://127.0.0.1:')) {
      return Response.json({ error: 'backend_url_required' }, { status: 400 });
    }
    const client = new Composio({
      apiKey: 'ak_workerd_import_smoke',
      baseURL: backendUrl,
      allowTracking: false,
      sensitiveFileUploadProtection: true,
    });
    const link = await client.connectedAccounts.link(
      'chickpea:membership:workerd_smoke',
      'ac_workerd_smoke',
      {
        callbackUrl: 'https://chickpea.example.test/admin/connections/composio/callback',
        allowMultiple: true,
      },
    );
    const direct = await client.tools.execute('GMAIL_GET_PROFILE', {
      userId: 'chickpea:membership:workerd_smoke',
      connectedAccountId: 'ca_workerd_smoke',
      version: COMPOSIO_TOOLKIT_VERSIONS.gmail,
      arguments: {},
    });
    const sheetsDirect = await client.tools.execute('GOOGLESHEETS_SEARCH_SPREADSHEETS', {
      userId: 'chickpea:membership:workerd_smoke',
      connectedAccountId: 'ca_sheets_workerd_smoke',
      version: COMPOSIO_TOOLKIT_VERSIONS.googlesheets,
      arguments: {
        query: 'Chickpea canary',
        max_results: 5,
        include_trashed: false,
      },
    });
    const session = await client.sessions.create(
      'chickpea:membership:workerd_smoke',
      {
        toolkits: ['gmail'],
        tools: { gmail: { enable: ['GMAIL_GET_PROFILE'] } },
        connectedAccounts: { gmail: 'ca_workerd_smoke' },
        manageConnections: false,
        sessionPreset: 'direct_tools',
        sandbox: { enable: false },
      },
    );
    const controller = new AbortController();
    controller.abort();
    let executeCancellation = '';
    try {
      const executeWithRequestOptions = session.execute as unknown as (
        tool: string,
        arguments_: Record<string, unknown>,
        modifiers: undefined,
        requestOptions: { signal: AbortSignal },
      ) => Promise<unknown>;
      await executeWithRequestOptions.call(
        session,
        'GMAIL_GET_PROFILE',
        { user_id: 'me' },
        undefined,
        { signal: controller.signal },
      );
    } catch (error) {
      executeCancellation = error instanceof Error ? error.name : 'UnknownError';
    }
    return Response.json({
      imported: typeof Composio === 'function',
      linkId: link.id,
      redirectUrl: link.redirectUrl,
      directSuccessful: direct.successful,
      directLogId: direct.logId,
      directResultKeys: Object.keys(direct.data).sort(),
      providerVersion: COMPOSIO_TOOLKIT_VERSIONS.gmail,
      sheetsDirectSuccessful: sheetsDirect.successful,
      sheetsDirectResultKeys: Object.keys(sheetsDirect.data).sort(),
      sheetsProviderVersion: COMPOSIO_TOOLKIT_VERSIONS.googlesheets,
      sessionId: session.sessionId,
      executeCancellation,
    });
  },
};
