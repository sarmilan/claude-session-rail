// session-rail's $.state contract: values held for the session that outlive a hot reload of the hooks module.
declare module 'claude-code' {
  interface PluginState {
    'session-rail': {
      // Whether the person's own /start has run in this session (/reload-plugins runs session.start again).
      startRan: boolean
      // The branch's approval as the go-ahead poll last saw it (hooks/goahead.ts), so a reload doesn't resend.
      approvalSeen: { branch: string; approvedAt: number | null } | null
    }
  }
}
