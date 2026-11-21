# Connected context sources

MeetOnTrack connects sources instead of importing individual files. The context
button opens the source chooser; Google account controls remain in Settings.
Git repositories are optional and continue to use the existing project selector.

## Local folders

1. Choose a directory with the native folder picker, or enter its absolute path.
2. Click **Connect folder (read-only)** to authorize retrieval. Merely choosing a
   path does not connect it.
3. Ask about the project during a meeting. The AI proposes search words; the local
   broker searches only connected directories and includes matching paths/lines.
4. Disconnect the source to exclude it from subsequent requests. This resets the
   reasoning thread on the next question without deleting visible chat or files.

The preference file stores paths only, not file copies or a document index.
Sources remain connected across meetings until removed. Retrieval reads current
contents on each question/analysis; there is no background folder polling.
Relevant excerpts are passed to the configured AI, which may be a cloud service.
A request already sent cannot be recalled by disconnecting its source.

Current limits: ten folders, UTF-8 text/Markdown/CSV/source code, 250 KB per file,
2,000 directory entries, 4 MB read, three-second cooperative search budget, twelve
matching lines of at most 1,200 characters. PDF and Office binaries are not parsed.
Slow filesystem calls can exceed the cooperative deadline; avoid network mounts.
Hidden entries, common generated directories, symlinks and credential-like
filenames are skipped. This is not content-level secret detection: only connect
folders whose contents the AI is allowed to read.

## Google Drive

Google is opt-in; connect/disconnect the account and enable Drive in Settings.
Calendar and Gmail remain independent switches. Access uses the existing `gws`
read-only broker, with no file uploads or local document copies.

Up to five search hits are returned. For the first two hits, Google Docs text
excerpts or Google Sheets first-sheet `A1:Z80` values can be read. Other formats,
missing permissions and API failures retain the title/link but are explicitly
labelled metadata-only. Returned excerpts are bounded and do not prove exhaustive
coverage. Results remain in memory for at most ten minutes; changing sources
clears them. Disconnect does not log out shared `gws` used for report delivery.

## Install the calendar reader (gws)

Home reads today's and tomorrow's Google Calendar events through `gws`, the
[Google Workspace CLI](https://github.com/googleworkspace/cli). MeetOnTrack only
reads the calendar. It never changes an event.

1. Install `gws` as its [installation guide](https://github.com/googleworkspace/cli#installation)
   describes. With Homebrew the package is `googleworkspace-cli`. The Homebrew
   package named `gws` is a different tool.
2. Sign `gws` in to the Google account whose calendar MeetOnTrack should read, as
   its [authentication guide](https://github.com/googleworkspace/cli#authentication)
   describes.
3. Reopen MeetOnTrack. If Home then says the calendar is not connected, click
   **Connect the calendar** and tick **Google Calendar** in the Google section.

## Regression checks

```sh
cd copilot/web
python3 -m unittest test_local_context test_local_context_llm test_context_sources_api test_google_context test_google_llm
cd ../..
node scripts/test-context-sources-ui.cjs
```

All fixtures are synthetic and temporary. Tests cover opt-in, fresh reads,
disconnect, source preservation, symlink/hidden-file exclusion, bounded search,
Google content/error states, LLM prompt integration, HTTP origin validation,
native-picker confirmation semantics, and removal of the upload endpoint.
The JavaScript handler test is not a rendered-browser acceptance test.
