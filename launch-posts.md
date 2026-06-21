# Launch Posts

## X
I spent a lot of time in bigger private systems pulling on the same threads over and over.

A formatter here. A search helper there. A PPTX parser. A SharePoint client. An EDGAR client. A few pieces around AI routing, document cleanup, action items, market data.

Eventually it felt a little silly to keep relearning the same lesson in private.

So I pulled the useful parts out, cleaned them up, took out the private wiring, and published them.

Partly because I’ve been on my own learning curve with all of this.
Partly because a lot of people were generous with me along the way.
Partly because open beats closed more often than we admit.

Repo: https://github.com/rdcahalane/oss-packages

A few of the packages:
- https://www.npmjs.com/package/channel-formatter
- https://www.npmjs.com/package/pptx-extractor
- https://www.npmjs.com/package/hybrid-search-pgvector
- https://www.npmjs.com/package/sharepoint-files

## LinkedIn
I’ve spent a good chunk of the last stretch building inside bigger private systems.

What happens, at least for me, is the same useful pieces keep showing up.

A formatter for AI output that has to survive different channels.
A PowerPoint extractor because too much good information is trapped in decks.
A hybrid search layer because plain vector search usually isn’t enough.
A SharePoint client because that is still where a lot of the real work lives.
An EDGAR client, action item extraction, document quality passes, lightweight market data, a small event study engine.

After a while it started to feel backwards to keep all of that tucked inside private projects.

So I pulled out the parts that seemed broadly useful, cleaned them up, removed the private integrations and company-specific assumptions, and published them as a public TypeScript monorepo.

Part of this is just trying to give something back.
I’ve learned a lot on this little run. Most of it the hard way. Not all of it by choice.
And a lot of people have been generous with what they’ve built, written, and shared openly.

So this is my turn.

Repo:
https://github.com/rdcahalane/oss-packages

Initial release:
https://github.com/rdcahalane/oss-packages/releases/tag/v0.1.0

A few live packages:
- channel-formatter
- pptx-extractor
- hybrid-search-pgvector
- sharepoint-files
- action-items
- @rdcahalane/ai-router
- @rdcahalane/edgar-client

If any of it is useful, great. If not, it still felt better out in the open than sitting in a private folder.
