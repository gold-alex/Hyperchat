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

const { detectMarketInfo, findByContains, scrollToElement, HYPERCHAT_STATE } = require('../content.js')

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
