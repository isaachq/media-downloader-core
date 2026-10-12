// A local test server on a free port that fetch() will actually connect to.
import type * as http from 'node:http'
import type {AddressInfo} from 'node:net'

/**
 * Ports the Fetch standard blocks ("bad ports": fetch fails with "bad port"
 * before connecting). https://fetch.spec.whatwg.org/#port-blocking — Node's
 * fetch (undici) enforces the same list.
 */
const FETCH_BLOCKED_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110,
  111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
])

/**
 * Listen on 127.0.0.1 and an OS-chosen port, never one fetch refuses. The
 * ephemeral range is usually 49152+, where none is blocked; Hyper-V, WSL or
 * Docker move it down (seen: 1024–15000), where ~0.14 % of the ports are —
 * enough to fail one test run in thirty at random.
 */
export async function listenLocal(server: http.Server): Promise<number> {
  for (;;) {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const {port} = server.address() as AddressInfo
    if (!FETCH_BLOCKED_PORTS.has(port)) return port
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

export const isFetchBlockedPort = (port: number): boolean => FETCH_BLOCKED_PORTS.has(port)
