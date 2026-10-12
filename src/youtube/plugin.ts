import {createHash} from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {writeAtomic} from '../core/files.js'

/**
 * A yt-dlp PO token provider plugin (yt-dlp ≥ 2025.05.22) that asks this
 * library's broker (`PoTokenBroker`) for tokens. yt-dlp hands the provider
 * the exact content binding it uses (visitor data, data sync id or video id),
 * so the token always matches what yt-dlp sends. Where to ask comes from the
 * environment of that one yt-dlp process — never the command line, which
 * other programs can read. Educational: see the README, "YouTube: attestation".
 */
export const PLUGIN_SOURCE = `# Media Download Core: YouTube PO tokens from the app that runs yt-dlp.
# Educational - see https://github.com/isaachq/media-downloader-core#youtube-attestation
# The app passes where to ask in this process's environment: MDC_POT_URL, MDC_POT_KEY.
import json
import os

from yt_dlp.extractor.youtube.pot.provider import (
    PoTokenContext,
    PoTokenProvider,
    PoTokenProviderError,
    PoTokenProviderRejectedRequest,
    PoTokenResponse,
    register_preference,
    register_provider,
)
from yt_dlp.extractor.youtube.pot.utils import WEBPO_CLIENTS, get_webpo_content_binding
from yt_dlp.networking.common import Request


@register_provider
class MdcPTP(PoTokenProvider):
    PROVIDER_NAME = 'mdc'
    PROVIDER_VERSION = '1.0.0'
    BUG_REPORT_LOCATION = 'https://github.com/isaachq/media-downloader-core/issues'
    _SUPPORTED_CLIENTS = WEBPO_CLIENTS
    _SUPPORTED_CONTEXTS = (PoTokenContext.GVS, PoTokenContext.PLAYER, PoTokenContext.SUBS)
    # the app's own browser reaches YouTube itself: yt-dlp's proxy settings are not ours to apply
    _SUPPORTED_EXTERNAL_REQUEST_FEATURES = None

    def is_available(self):
        return bool(os.environ.get('MDC_POT_URL') and os.environ.get('MDC_POT_KEY'))

    def _real_request_pot(self, request):
        binding, binding_type = get_webpo_content_binding(request)
        if not binding:
            raise PoTokenProviderRejectedRequest('no content binding for this request')
        body = json.dumps({
            'binding': binding,
            'binding_type': binding_type.value if binding_type else None,
            'context': request.context.value,
            'client': request.internal_client_name,
            'video_id': request.video_id,
        }).encode()
        try:
            answer = json.load(self._request_webpage(
                Request(
                    os.environ['MDC_POT_URL'], data=body,
                    headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + os.environ['MDC_POT_KEY']},
                    proxies={'all': None}, extensions={'timeout': 60.0}),
                note=f'Asking the app for a {request.context.value} PO token'))
        except Exception as error:
            raise PoTokenProviderError(f'the app could not provide a PO token: {error}', expected=True) from error
        token = answer.get('po_token')
        if not token:
            raise PoTokenProviderError(answer.get('error') or 'the app answered without a token', expected=True)
        return PoTokenResponse(po_token=token, expires_at=answer.get('expires_at'))


@register_preference(MdcPTP)
def mdc_preference(provider, request):
    return 1000
`

/** Bumped with the source: a changed plugin is written again, an unchanged one is left alone. */
const PLUGIN_DIGEST = createHash('sha256').update(PLUGIN_SOURCE).digest('hex').slice(0, 16)

/**
 * Write the plugin under `root` (once per version) and return the folder to
 * pass as `--plugin-dirs`. yt-dlp looks for `<child>/yt_dlp_plugins/extractor/`
 * in each child of that folder.
 */
export async function installPlugin(root: string): Promise<string> {
  const file = path.join(root, 'mdc-pot', 'yt_dlp_plugins', 'extractor', 'mdc_pot.py')
  const stamp = path.join(root, 'mdc-pot', 'version')
  const current = await fs.readFile(stamp, 'utf8').catch(() => '')
  if (current !== PLUGIN_DIGEST || !(await exists(file))) {
    await fs.mkdir(path.dirname(file), {recursive: true})
    await writeAtomic(file, PLUGIN_SOURCE)
    await writeAtomic(stamp, PLUGIN_DIGEST)
  }
  return root
}

const exists = (file: string): Promise<boolean> =>
  fs.access(file).then(
    () => true,
    () => false,
  )
