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
    assert.ok(performance.now() - started < 500)
  })
})
