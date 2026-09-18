// Tests for content.js
//
// The content script is now only market detection, the wallet bridge, and element
// scrolling - the chat itself moved to the side panel. These cover the parts that
// read Hyperliquid's DOM, which is where this script actually earns its keep.

jest.useFakeTimers()

// Mirrors the nesting the desktop selector walks:
// #coinInfo > div > div:nth-child(2) > div:nth-child(1) > div > div > div > div:nth-child(2) > div
function coinInfoDom(pairText) {
  return `
    <div id="coinInfo">
      <div>
        <div>filler</div>
        <div>
          <div>
            <div>
              <div>
                <div>
                  <div>filler</div>
                  <div>
                    <div>${pairText}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `
}

const { detectMarketInfo, normalizePair, findByContains, scrollToElement, HYPERCHAT_STATE } = require('../content.js')

beforeEach(() => {
  document.body.innerHTML = ''
  HYPERCHAT_STATE.currentPair = ''
  HYPERCHAT_STATE.currentMarket = ''
  delete window.CHAT_PAIR_OVERRIDE
  delete window.CHAT_MARKET_OVERRIDE
  Element.prototype.scrollIntoView = jest.fn()
})

describe('market detection', () => {
  it('reads the pair from the desktop coin info panel', () => {
    document.body.innerHTML = coinInfoDom('BTC-USD')

    detectMarketInfo()

    expect(HYPERCHAT_STATE.currentPair).toBe('BTC-USD')
    expect(HYPERCHAT_STATE.currentMarket).toBe('Perps')
  })

  it('strips the welcome banner when it bleeds into the pair node', () => {
    document.body.innerHTML = coinInfoDom('Welcome to Hyperliquid HYPE-USD')

    detectMarketInfo()

    expect(HYPERCHAT_STATE.currentPair).toBe('HYPE-USD')
  })

  it('falls back to the coin icon when the panel selector misses', () => {
    document.body.innerHTML = `
      <div>
        <div style="display: flex">
          <img alt="eth" src="https://app.hyperliquid.xyz/coins/ETH.svg" />
        </div>
        <div>ETH-USD</div>
      </div>
    `

    detectMarketInfo()

    expect(HYPERCHAT_STATE.currentPair).toBe('ETH-USD')
  })

  it('separates spot from perps', () => {
    document.body.innerHTML = `
      ${coinInfoDom('PURR-USDC')}
      <div style="background: rgb(7, 39, 35)">
        <div class="sc-bjfHbI jxtURp body12Regular">Spot</div>
      </div>
    `

    detectMarketInfo()

    expect(HYPERCHAT_STATE.currentPair).toBe('PURR-USDC')
    expect(HYPERCHAT_STATE.currentMarket).toBe('Spot')
  })

  it('does not let the leverage badge become part of the room', () => {
    // Hyperliquid's mobile layout puts the pair and the "10x" badge in one
    // subtree. Reading textContent wholesale produced "HYPE-USDC10x", a room
    // nobody else was in, so widening the side panel emptied the chat.
    document.body.innerHTML = coinInfoDom('HYPE-USDC10x')

    detectMarketInfo()

    expect(HYPERCHAT_STATE.currentPair).toBe('HYPE-USDC')
  })

  it('picks the pair out of a cluttered container', () => {
    document.body.innerHTML = `
      <div>
        <div style="display: flex">
          <img alt="hype" src="https://app.hyperliquid.xyz/coins/HYPE.svg" />
        </div>
        <div>
          <div>HYPE-USDC<span>10x</span></div>
          <div>91.769 +8.484 / +10.19%</div>
        </div>
      </div>
    `

    detectMarketInfo()

    expect(HYPERCHAT_STATE.currentPair).toBe('HYPE-USDC')
  })

  it('reports UNKNOWN rather than guessing when the page has nothing', () => {
    document.body.innerHTML = '<div>no market here</div>'

    detectMarketInfo()

    expect(HYPERCHAT_STATE.currentPair).toBe('UNKNOWN')
  })

  it('honours the override used by the standalone chat window', () => {
    window.CHAT_PAIR_OVERRIDE = 'SOL-USD'
    window.CHAT_MARKET_OVERRIDE = 'Spot'

    detectMarketInfo()

    expect(HYPERCHAT_STATE.currentPair).toBe('SOL-USD')
    expect(HYPERCHAT_STATE.currentMarket).toBe('Spot')
  })
})

describe('pair extraction', () => {
  it('strips anything bolted onto the pair', () => {
    expect(normalizePair('HYPE-USDC10x')).toBe('HYPE-USDC')
    expect(normalizePair('Welcome to Hyperliquid HYPE-USD')).toBe('HYPE-USD')
    expect(normalizePair('BTC-USD 10x Cross')).toBe('BTC-USD')
    expect(normalizePair('  ETH-USD\n')).toBe('ETH-USD')
  })

  it('keeps the k prefix on the k-markets, which are real distinct markets', () => {
    expect(normalizePair('kPEPE-USD')).toBe('kPEPE-USD')
    expect(normalizePair('kBONK-USD20x')).toBe('kBONK-USD')
  })

  it('handles spot pairs written with a slash', () => {
    expect(normalizePair('PURR/USDC')).toBe('PURR/USDC')
  })

  it('returns null when there is no pair to find', () => {
    expect(normalizePair('Welcome to Hyperliquid')).toBeNull()
    expect(normalizePair('')).toBeNull()
    expect(normalizePair(null)).toBeNull()
  })
})

describe('element links', () => {
  it('prefers the smallest element containing the text', () => {
    document.body.innerHTML = `
      <div id="outer">
        Open Interest and a great deal of other page text
        <div id="inner">Open Interest</div>
      </div>
    `

    const outer = document.getElementById('outer')
    const inner = document.getElementById('inner')
    outer.getBoundingClientRect = () => ({ width: 1000, height: 800 })
    inner.getBoundingClientRect = () => ({ width: 100, height: 20 })

    expect(findByContains("div:contains('Open Interest')")).toBe(inner)
  })

  it('ignores elements too large to be the thing you meant', () => {
    document.body.innerHTML = '<div id="huge">Funding Rate</div>'
    document.getElementById('huge').getBoundingClientRect = () => ({ width: 5000, height: 5000 })

    expect(findByContains("div:contains('Funding Rate')")).toBeNull()
  })

  it('returns null for a malformed selector instead of throwing', () => {
    expect(findByContains('div:contains(')).toBeNull()
  })

  it('scrolls to an element by id and clears the highlight afterwards', () => {
    document.body.innerHTML = '<div id="tv_chart_container">chart</div>'
    const target = document.getElementById('tv_chart_container')

    scrollToElement('#tv_chart_container')

    expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })
    expect(target.classList.contains('hl-element-highlight')).toBe(true)

    jest.advanceTimersByTime(2000)
    expect(target.classList.contains('hl-element-highlight')).toBe(false)
  })

  it('does nothing when the target is not on the page', () => {
    expect(() => scrollToElement('#does-not-exist')).not.toThrow()
  })
})
