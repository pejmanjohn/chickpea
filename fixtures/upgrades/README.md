# Populated upgrade baseline

`v0.1.0.json` is the synthetic fixture recipe for the initial release. It contains
no account coordinates or credentials. Bind its references to registered test
actors, a disposable customer-path Worker, and a synthetic provider fixture in
the private live-verification spec. Do not use a standing QA lane as a disposable
installation. Follow `qa/live/operator/SKILL.md` for the attended record.

1. Retain the exact verified v0.1.0 source and its source-export receipt. Deploy
   it through the guarded customer path to the selected disposable Worker.
   For the first release rehearsal, use the reviewed candidate commit and a
   privately built compatible test candidate; do not publish a fake v0.1.1.
2. Sign in as the Owner, verify a distinct Member, and create the run-named Agent,
   memory, connection reference, and bounded schedule described in the recipe.
   Record their exact IDs, saved values, scopes, grants, and resource identities
   privately. Establish a real provider read and Slack reply before proceeding.
3. Build a compatible candidate with a different version, the initial version
   in `supportedOrigins`, and unchanged storage/migration digests. Run the same
   wrapper context and state-machine tests used by the published command.
   Test fixtures may inject release responses in process; the production CLI
   must continue to require an immutable release from the official repository.
4. Exercise each listed transition. Before-upload failure must leave the prior
   version serving. After-upload failure must retain its uploaded Worker ID.
   Resume through the receipt; recover using the retained previous code.
   Interrupt only the test command, never another operator's process.
5. After each transition compare every `preserve` item with the recorded
   before-value. Check actual Owner/Member behavior, a fresh Slack request and
   thread follow-up, the existing connection's provider read, and a real due
   occurrence spanning the transition. Inspect canonical occurrence/delivery
   evidence for duplicates; a successful upload or an Agent's claim is not proof.
6. Pause the schedule at its occurrence budget or deadline, confirm no further
   delivery, and perform the recipe's exact cleanup. Preserve failed attempts
   and the final readbacks in the private run record.

The deterministic tests prove guards and retry state transitions. This recipe
defines the separate attended upgrade/recovery acceptance; its presence is not
evidence that a live deployment passed.
