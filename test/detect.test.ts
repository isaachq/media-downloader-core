import {strict as assert} from 'node:assert'
import {describe, it} from 'node:test'
import {detectLink} from '../src/sources/detect.js'

const site = (text: string) => detectLink(text)?.site

describe('detectLink: the site of a pasted or shared link', () => {
  it('names each site by its domains, subdomains included', () => {
    assert.equal(site('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'youtube')
    assert.equal(site('https://youtu.be/dQw4w9WgXcQ'), 'youtube')
    assert.equal(site('https://www.tiktok.com/@nasa/video/7300000000000000000'), 'tiktok')
    assert.equal(site('https://vm.tiktok.com/ZMabc123/'), 'tiktok')
    assert.equal(site('https://www.instagram.com/reel/C1abcDEF/'), 'instagram')
    assert.equal(site('https://instagr.am/p/C1abcDEF/'), 'instagram')
    assert.equal(site('https://www.facebook.com/share/r/19qKig4dBU/'), 'facebook')
    assert.equal(site('https://m.facebook.com/reel/1158775390014135/'), 'facebook')
    assert.equal(site('https://fb.watch/abc123/'), 'facebook')
    assert.equal(site('https://vk.com/video-22822305_456242110'), 'vk')
    assert.equal(site('https://m.vk.com/clip-22822305_456242110'), 'vk')
    assert.equal(site('https://vkvideo.ru/video-22822305_456242110'), 'vk')
    assert.equal(site('https://vk.cc/abc'), 'vk')
    assert.equal(site('https://x.com/nasa/status/1585341984679469056'), 'x')
    assert.equal(site('https://twitter.com/nasa/status/1585341984679469056?s=20'), 'x')
    assert.equal(site('https://mobile.twitter.com/i/status/1585341984679469056'), 'x')
    assert.equal(site('https://t.co/D68z4K2wq7'), 'x')
    // what XSource and VkSource take, detection names the same
    assert.equal(site('https://fxtwitter.com/a/status/1585341984679469056'), 'x')
    assert.equal(site('https://vxtwitter.com/a/status/1'), 'x')
    assert.equal(site('https://fixupx.com/a/status/1'), 'x')
    assert.equal(site('https://fixvx.com/a/status/1'), 'x')
    assert.equal(site('https://vkontakte.ru/video1_2'), 'vk')
  })

  it('names Snapchat on its main host and on its short-link and story subdomains', () => {
    assert.equal(
      site('https://www.snapchat.com/spotlight/W7_EDlXWTBiXAEEniNoMPwAAYeG9xcGd0ZWd3AZ14BVv0AZ14BQkrAAAAAQ'),
      'snapchat',
    )
    assert.equal(site('https://snapchat.com/@nasa'), 'snapchat')
    assert.equal(site('https://www.snapchat.com/add/djkhaled305?share_id=1'), 'snapchat')
    assert.equal(site('https://story.snapchat.com/s/djkhaled305'), 'snapchat')
    assert.equal(site('https://t.snapchat.com/eFgH5678'), 'snapchat')
    assert.equal(site('Look: https://www.snapchat.com/t/aBcD1234.'), 'snapchat')
    assert.equal(detectLink('https://www.snapchat.com/@nasa')?.host, 'snapchat.com')
    assert.equal(site('https://snapchat.com.evil.example/@nasa'), 'web')
    assert.equal(site('https://notsnapchat.com/@nasa'), 'web')
  })

  it('names Threads on threads.com and the old threads.net', () => {
    assert.equal(site('https://www.threads.com/@zuck/post/DHV7vTivqWD'), 'threads')
    assert.equal(site('https://threads.net/@zuck'), 'threads')
    assert.equal(site('https://www.threads.net/t/Ddt7cL5EfUG?xmt=1'), 'threads')
    assert.equal(site('See https://www.threads.com/@mosseri.'), 'threads')
    assert.equal(detectLink('https://www.threads.com/@zuck')?.host, 'threads.com')
    assert.equal(site('https://threads.com.evil.example/@zuck'), 'web')
    assert.equal(site('https://notthreads.net/@zuck'), 'web')
  })

  it('names Bluesky on bsky.app', () => {
    assert.equal(site('https://bsky.app/profile/bsky.app/post/3mnslrkd6ok2g'), 'bluesky')
    assert.equal(site('https://bsky.app/profile/did:plc:z72i7hdynmk6r22z27h6tvur'), 'bluesky')
    assert.equal(site('Look: https://www.bsky.app/profile/jay.bsky.team/post/3mwhqanugyc2z!'), 'bluesky')
    assert.equal(detectLink('https://bsky.app/profile/theverge.com')?.host, 'bsky.app')
    assert.equal(site('https://bsky.app.evil.example/profile/bsky.app'), 'web')
    assert.equal(site('https://notbsky.app/profile/bsky.app'), 'web')
  })

  it('names Twitch on twitch.tv and clips.twitch.tv', () => {
    assert.equal(site('https://clips.twitch.tv/FaintLightGullWholeWheat'), 'twitch')
    assert.equal(site('https://www.twitch.tv/shroud/clip/PreciousRelievedCodCorgiDerp-IqjaHMAL8JQQH78F'), 'twitch')
    assert.equal(site('Watch: https://m.twitch.tv/shroud/clips?range=7d.'), 'twitch')
    assert.equal(site('https://www.twitch.tv/videos/2602093345'), 'twitch')
    assert.equal(site('https://player.twitch.tv/?video=v2602093345&parent=example.com'), 'twitch')
    assert.equal(detectLink('https://www.twitch.tv/shroud')?.host, 'twitch.tv')
    assert.equal(site('https://twitch.tv.evil.example/shroud'), 'web')
    assert.equal(site('https://nottwitch.tv/shroud'), 'web')
  })

  it('any other site is "web", and a link straight to a file says so', () => {
    const page = detectLink('https://www.trannyvideosx.com/video/81455/ts-havenna-sofia-solo-1')
    assert.deepEqual(page, {
      site: 'web',
      url: 'https://www.trannyvideosx.com/video/81455/ts-havenna-sofia-solo-1',
      host: 'trannyvideosx.com',
      file: false,
    })
    assert.equal(detectLink('https://cdn.example.org/clips/a.MP4?sig=1')?.file, true)
    assert.equal(detectLink('https://example.org/a.mp4.html')?.file, false)
  })

  it('does not take a look-alike host for a site', () => {
    assert.equal(site('https://notx.com/a'), 'web')
    assert.equal(site('https://myvk.com/video1_2'), 'web')
    assert.equal(site('https://facebook.com.evil.example/reel/1/'), 'web')
    assert.equal(site('https://evil.example/?u=https://x.com/a/status/1'), 'web')
  })

  it('finds the link inside the text an app shares, without the punctuation after it', () => {
    const shared = detectLink('Mira este video 😂 https://www.facebook.com/share/r/19qKig4dBU/, está buenísimo')
    assert.equal(shared?.url, 'https://www.facebook.com/share/r/19qKig4dBU/')
    assert.equal(shared?.site, 'facebook')
    assert.equal(detectLink('(https://x.com/a/status/1)')?.url, 'https://x.com/a/status/1')
    // a parenthesis the link opened is its own; one the sentence opened is not
    assert.equal(detectLink('https://en.wikipedia.org/wiki/Foo_(bar)')?.url, 'https://en.wikipedia.org/wiki/Foo_(bar)')
    assert.equal(
      detectLink('(ver https://en.wikipedia.org/wiki/Foo_(bar)).')?.url,
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    )
    assert.equal(detectLink('¿Viste esto? https://x.com/a/status/1?!')?.url, 'https://x.com/a/status/1')
    assert.equal(detectLink('  https://vk.com/video1_2\n')?.url, 'https://vk.com/video1_2')
  })

  it('unwraps Instagram and Facebook outbound links', () => {
    const wrapped = `https://l.instagram.com/?u=${encodeURIComponent('https://x.com/a/status/1')}&e=AT0`
    assert.deepEqual([detectLink(wrapped)?.site, detectLink(wrapped)?.url], ['x', 'https://x.com/a/status/1'])
    const fb = `https://l.facebook.com/l.php?u=${encodeURIComponent('https://vk.com/video1_2')}&h=AT1`
    assert.equal(detectLink(fb)?.site, 'vk')
    assert.equal(detectLink('https://l.facebook.com/l.php?u=%E0%A4%A')?.site, 'facebook')
  })

  it('is undefined without an http(s) link, and maps local fakes by host:port', () => {
    assert.equal(detectLink('hola'), undefined)
    assert.equal(detectLink('ftp://x.com/a'), undefined)
    assert.equal(detectLink(''), undefined)
    assert.equal(detectLink('http://127.0.0.1:4100/reel/1/', {'127.0.0.1:4100': 'facebook'})?.site, 'facebook')
    assert.equal(detectLink('http://127.0.0.1:4200/reel/1/', {'127.0.0.1:4100': 'facebook'})?.site, 'web')
  })

  it('stays linear on long hostile input', () => {
    const long = `https://${'a'.repeat(200_000)}`
    const started = performance.now()
    assert.equal(detectLink(long)?.site, 'web')
    assert.equal(detectLink(`${' '.repeat(200_000)}x`), undefined)
    assert.equal(detectLink(`https://x.com/a${')'.repeat(200_000)}`)?.url, 'https://x.com/a')
    assert.equal(detectLink(`https://x.com/a${'.)'.repeat(100_000)}`)?.url, 'https://x.com/a')
    assert.ok(performance.now() - started < 500)
  })
})
