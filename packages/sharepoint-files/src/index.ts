/**
 * sharepoint-files
 *
 * Microsoft 365 SharePoint file access via the Graph API.
 * Handles client-credentials auth, drive discovery, file listing,
 * file download, and plain-text extraction from common Office formats.
 *
 * All config is passed at construction time — no hardcoded credentials,
 * tenant IDs, or SharePoint URLs. Works in Node.js and Cloudflare Workers
 * (uses the global fetch API, no Node-specific HTTP modules).
 *
 * Usage:
 *   import { createSharePointClient } from "sharepoint-files";
 *
 *   const sp = createSharePointClient({
 *     tenantId:     process.env.MICROSOFT_TENANT_ID!,
 *     clientId:     process.env.MICROSOFT_CLIENT_ID!,
 *     clientSecret: process.env.MICROSOFT_CLIENT_SECRET!,
 *   });
 *
 *   // Get a site by its host:path identifier
 *   const site = await sp.getSite("contoso.sharepoint.com:/sites/Research");
 *
 *   // List all drives (document libraries) on the site
 *   const drives = await sp.listDrives(site.id);
 *
 *   // List files in a folder (BFS, up to maxDepth levels)
 *   const files = await sp.listFiles(drives[0].id, { maxDepth: 3, maxFiles: 200 });
 *
 *   // Download a file as ArrayBuffer
 *   const buffer = await sp.downloadFile(drives[0].id, files[0].id);
 *
 *   // Extract plain text from a downloaded buffer
 *   const text = await sp.extractText(buffer, files[0].name);
 *
 *   // Combined: download + extract in one call
 *   const { text, webUrl } = await sp.downloadAndExtract(drives[0].id, files[0].id, files[0].name);
 *
 * Required Azure app permissions (application, not delegated):
 *   Files.Read.All — scoped to the specific SharePoint site
 *   (Sites.Read.All is NOT required when using the host:path site accessor)
 */

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

// ── Config & Types ─────────────────────────────────────────────────────────────

export interface SharePointClientConfig {
  /** Azure AD tenant ID */
  tenantId: string;
  /** Azure app client ID */
  clientId: string;
  /** Azure app client secret */
  clientSecret: string;
  /** Max pages to follow when paginating Graph API results (default 5) */
  maxPages?: number;
}

export interface SharePointSite {
  id: string;
  displayName: string;
  webUrl: string;
}

export interface SharePointDrive {
  id: string;
  name: string;
  webUrl: string;
  driveType: string;
}

export interface SharePointFile {
  id: string;
  name: string;
  /** File MIME type (present on files, absent on folders) */
  mimeType?: string;
  /** File size in bytes */
  size: number;
  lastModifiedDateTime: string;
  webUrl: string;
  /** Full path relative to drive root, e.g. "Documents/Research/deck.pptx" */
  drivePath: string;
}

export interface ListFilesOptions {
  /** Max BFS depth to traverse (default 4) */
  maxDepth?: number;
  /** Max total files to collect (default 500) */
  maxFiles?: number;
  /** Only return files whose name matches this regex */
  nameFilter?: RegExp;
  /** Skip files larger than this size in bytes (default: no limit) */
  maxBytes?: number;
  /** Only return files modified after this ISO date string */
  modifiedAfter?: string;
}

export interface DownloadAndExtractResult {
  text: string | null;
  webUrl: string;
  sizeBytes: number;
}

// ── Text extraction helpers ────────────────────────────────────────────────────

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".csv", ".json", ".html", ".htm"]);
const OFFICE_EXTENSIONS = new Set([".docx", ".doc", ".pdf", ".pptx", ".xlsx"]);

export function isSupportedTextFile(filename: string): boolean {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return TEXT_EXTENSIONS.has(ext) || OFFICE_EXTENSIONS.has(ext);
}

/**
 * Extract plain text from a file buffer based on the file extension.
 *
 * Supported formats:
 *   .txt / .md / .csv / .json / .html — decoded as UTF-8
 *   .pptx — fflate unzip → per-slide <a:t> text runs (requires fflate to be installed)
 *   .docx — mammoth text extraction (requires mammoth to be installed)
 *   .pdf  — unpdf text extraction (requires unpdf to be installed)
 *   .xlsx — basic shared-strings XML extraction via fflate
 *
 * All heavy dependencies are dynamically imported — install only what you need.
 *
 * @returns Extracted text, or null if the format is unsupported or extraction fails.
 */
export async function extractText(
  buffer: ArrayBuffer,
  filename: string,
): Promise<string | null> {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();

  if (TEXT_EXTENSIONS.has(ext)) {
    return new TextDecoder().decode(buffer);
  }

  if (ext === ".pptx" || ext === ".xlsx") {
    try {
      const fflate = "fflate";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { unzipSync } = (await import(fflate)) as any;
      const uint8 = new Uint8Array(buffer);
      const unzipped = unzipSync(uint8);
      const parts: string[] = [];

      for (const [path, data] of Object.entries(unzipped)) {
        // PPTX slides
        if (ext === ".pptx" && /^ppt\/slides\/slide\d+\.xml$/.test(path)) {
          const xml = new TextDecoder().decode(data as Uint8Array);
          for (const m of xml.matchAll(/<a:t>([^<]+)<\/a:t>/g)) parts.push(m[1]);
        }
        // XLSX shared strings (cell values)
        if (ext === ".xlsx" && path === "xl/sharedStrings.xml") {
          const xml = new TextDecoder().decode(data as Uint8Array);
          for (const m of xml.matchAll(/<t[^>]*>([^<]+)<\/t>/g)) parts.push(m[1]);
        }
      }

      return parts.length ? parts.join(" ") : null;
    } catch {
      return null;
    }
  }

  if (ext === ".pdf") {
    try {
      const unpdf = "unpdf";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = (await import(unpdf)) as any;
      const result = await mod.extractText(new Uint8Array(buffer));
      return (result?.text as string[] | undefined)?.join("\n\n") ?? null;
    } catch {
      return null;
    }
  }

  if (ext === ".docx" || ext === ".doc") {
    try {
      const mammothPkg = "mammoth";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mammoth = (await import(mammothPkg)) as any;
      const result = await mammoth.extractRawText({ buffer: Buffer.from(buffer) });
      return (result?.value as string) || null;
    } catch {
      return null;
    }
  }

  return null;
}

// ── Client factory ─────────────────────────────────────────────────────────────

export function createSharePointClient(config: SharePointClientConfig) {
  const { tenantId, clientId, clientSecret, maxPages = 5 } = config;
  let _token: string | null = null;
  let _tokenExpiry = 0;

  // ── Auth ──────────────────────────────────────────────────────────────────

  async function getToken(): Promise<string> {
    if (_token && Date.now() < _tokenExpiry - 60_000) return _token;

    const res = await fetch(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: clientId,
          client_secret: clientSecret,
          scope: "https://graph.microsoft.com/.default",
        }),
      },
    );

    if (!res.ok) {
      const err = await res.text().catch(() => res.status.toString());
      throw new Error(`M365 auth failed (${res.status}): ${err.slice(0, 200)}`);
    }

    const data = (await res.json()) as { access_token: string; expires_in: number };
    _token = data.access_token;
    _tokenExpiry = Date.now() + data.expires_in * 1_000;
    return _token;
  }

  // ── Graph helpers ─────────────────────────────────────────────────────────

  async function graphGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const token = await getToken();
    const url = new URL(`${GRAPH_BASE}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const err = await res.text().catch(() => res.status.toString());
      throw new Error(`Graph ${path} → ${res.status}: ${err.slice(0, 200)}`);
    }
    return res.json() as Promise<T>;
  }

  async function graphGetAll<T>(
    path: string,
    params: Record<string, string> = {},
  ): Promise<T[]> {
    const items: T[] = [];
    let data = await graphGet<{ value?: T[]; "@odata.nextLink"?: string }>(path, params);
    items.push(...(data.value ?? []));

    let pages = 1;
    while (data["@odata.nextLink"] && pages < maxPages) {
      const token = await getToken();
      const res = await fetch(data["@odata.nextLink"], {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) break;
      data = await res.json();
      items.push(...(data.value ?? []));
      pages++;
    }

    return items;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  return {
    /**
     * Get a SharePoint site by its "hostname:/path" identifier.
     *
     * Examples:
     *   "contoso.sharepoint.com:/sites/Research"
     *   "contoso.sharepoint.com:/teams/Engineering"
     *
     * Does not require Sites.Read.All — works with site-scoped Files.Read.All.
     */
    async getSite(siteRef: string): Promise<SharePointSite> {
      return graphGet<SharePointSite>(`/sites/${siteRef}`);
    },

    /** List all document library drives on a site */
    async listDrives(siteId: string): Promise<SharePointDrive[]> {
      return graphGetAll<SharePointDrive>(`/sites/${siteId}/drives`, {
        $select: "id,name,webUrl,driveType",
      });
    },

    /**
     * Recursively list all files in a drive using BFS.
     *
     * @param driveId   Graph API drive ID
     * @param options   Filter + depth controls
     */
    async listFiles(
      driveId: string,
      options: ListFilesOptions = {},
    ): Promise<SharePointFile[]> {
      const {
        maxDepth = 4,
        maxFiles = 500,
        nameFilter,
        maxBytes,
        modifiedAfter,
      } = options;

      const allFiles: SharePointFile[] = [];
      const queue: { folderId: string; path: string; depth: number }[] = [
        { folderId: "root", path: "", depth: 0 },
      ];

      while (queue.length && allFiles.length < maxFiles) {
        const { folderId, path, depth } = queue.shift()!;
        if (depth > maxDepth) continue;

        let items: Array<{
          id: string;
          name: string;
          file?: { mimeType: string };
          folder?: object;
          size?: number;
          lastModifiedDateTime?: string;
          webUrl?: string;
        }>;

        try {
          items = await graphGetAll(
            `/drives/${driveId}/items/${folderId}/children`,
            {
              $select: "id,name,file,folder,size,lastModifiedDateTime,webUrl",
              $orderby: "lastModifiedDateTime desc",
              $top: "200",
            },
          );
        } catch {
          continue;
        }

        for (const item of items) {
          if (item.folder) {
            queue.push({
              folderId: item.id,
              path: path ? `${path}/${item.name}` : item.name,
              depth: depth + 1,
            });
            continue;
          }

          if (!item.file) continue;

          // Apply filters
          if (nameFilter && !nameFilter.test(item.name)) continue;
          if (maxBytes && (item.size ?? 0) > maxBytes) continue;
          if (modifiedAfter && item.lastModifiedDateTime) {
            if (new Date(item.lastModifiedDateTime) < new Date(modifiedAfter)) continue;
          }

          allFiles.push({
            id: item.id,
            name: item.name,
            mimeType: item.file.mimeType,
            size: item.size ?? 0,
            lastModifiedDateTime: item.lastModifiedDateTime ?? "",
            webUrl: item.webUrl ?? "",
            drivePath: path ? `${path}/${item.name}` : item.name,
          });

          if (allFiles.length >= maxFiles) break;
        }
      }

      return allFiles;
    },

    /** Download a single file as ArrayBuffer */
    async downloadFile(driveId: string, itemId: string): Promise<ArrayBuffer> {
      const token = await getToken();
      const res = await fetch(
        `${GRAPH_BASE}/drives/${driveId}/items/${itemId}/content`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) throw new Error(`Download failed: ${res.status}`);
      return res.arrayBuffer();
    },

    /**
     * Fetch file metadata (size, webUrl, lastModifiedDateTime) without downloading content.
     * Useful for pre-flight size checks before deciding whether to download.
     */
    async getFileMeta(
      driveId: string,
      itemId: string,
    ): Promise<{ id: string; name: string; size: number; webUrl: string; lastModifiedDateTime: string }> {
      return graphGet(`/drives/${driveId}/items/${itemId}`, {
        $select: "id,name,size,webUrl,lastModifiedDateTime",
      });
    },

    /**
     * Download a file and extract plain text from it.
     * Returns null text if extraction fails or format is unsupported.
     *
     * @param maxBytes Skip download if file exceeds this size (default: no limit)
     */
    async downloadAndExtract(
      driveId: string,
      itemId: string,
      filename: string,
      maxBytes?: number,
    ): Promise<DownloadAndExtractResult> {
      const meta = await this.getFileMeta(driveId, itemId);

      if (maxBytes && meta.size > maxBytes) {
        return { text: null, webUrl: meta.webUrl, sizeBytes: meta.size };
      }

      const buffer = await this.downloadFile(driveId, itemId);
      const text = await extractText(buffer, filename);
      return { text, webUrl: meta.webUrl, sizeBytes: meta.size };
    },

    /** Re-export text extraction for use without downloading (e.g. from a cached buffer) */
    extractText,
    isSupportedTextFile,
  };
}

export type SharePointClient = ReturnType<typeof createSharePointClient>;
