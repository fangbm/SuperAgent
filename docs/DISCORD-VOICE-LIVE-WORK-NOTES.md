# Live voice-room follow-up — 2026-11-03

User reports the requested create-room option is absent in the Discord server and asks for online research. Inspect live state before changing it; keep desktop screenshots ignored and do not join voice/microphone or change unrelated guilds.

## Findings

- Native Discord desktop inspection shows guild1567099916126527530 has one existing four-place party voice channel and no creator lobby. Its member list shows only the owner, no bot. No Discord bot token is configured in the known process/secret-file locations.
- PR4 contains the SuperAgent join-to-create lifecycle and the setup command, but neither a PR nor an offline code bundle activates a live server feature. The missing visible entry and missing running bot are deployment gaps, not evidence the feature is already usable.
- TempVoice's maintained setup guide describes a creator voice channel plus a control interface; a running bot creates the room on join. Native channel creation permission alone is not the intended per-party automation.
- References: https://github.com/TempVoice/Documentation/blob/main/getting-started/setup.md and https://discord.com/discovery/applications/762217899355013120 . Official platform operations are guild-channel creation, Guild Voice States events and Modify Guild Member channel_id with Connect/Move Members.

## Locked next steps

The existing approved architecture uses SuperAgent on the friend's PC, with no additional service chosen. Asked the user to choose keeping that route versus installing hosted TempVoice for immediate rooms. Installing another provider is dependent on that choice; do not silently add it or run both controllers on the same lobby. If keeping SuperAgent, prepare the missing lobby and accurate pending status; do not claim automatic room creation works until the bot is running and a real join creates/moves/cleans a room. If choosing TempVoice, inspect concrete installation permissions, scope it to the existing voice category, configure one creator/interface, and verify a real second party room without recording audio. Update actual server-state evidence separately from implementation/tests.

No server configuration, bot installation, messages or voice connection changed during the initial inspection. Desktop navigation only expanded the voice category and showed the member list.

## Authorized preparation completed

Kept the prior SuperAgent/friend-PC route as the default while the optional hosted-service choice is pending. Created creator lobby1567192297181814804 under existingVOICE, defaultunlimited capacity, explicitEveryoneViewallow/Connectdeny. Posted content/voice-room-setup-status.md once in LFG, with channel mention and accurate bot-offline status. Cosmetic Warrior-role preview shows the visible locked lobby; exited preview and left Discord in LFG. No voice/mic joined, no bot installed, no external service authorized/activated.

Fixed setup adoption: --setup reuses the prepared lobby and explicitly grants View/Connect plus resets its capacity to0. Regression test proves the existing ID is retained and no duplicate lobby is POSTed. This is activation preparation, not a working auto-room claim.

Verification completed: member preview confirms a visible locked creator lobby; LFG status message visibly posted. Full pnpm check passes209Node tests and6Python suites;45frozen files unchanged. The existing lobby activation regression verifies ID reuse, no extra channel POST, explicit View/Connect grant and unlimited lobby capacity. Actual automatic room creation remains untested because no bot is running. The optional hosted-service question is still unanswered; the prior SuperAgent/friend-PC plan remains the default.
