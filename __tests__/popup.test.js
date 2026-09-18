// Tests for popup.js
//
// The previous version of this file tested an "Open Chat" button that sent a
// toggleChat message. popup.js has never had either - it renders a single
// "Open Side Panel" button - so the suite was failing before any of this work.

describe('Popup Script', () => {
  beforeEach(() => {
    jest.resetModules()
    document.body.innerHTML = '<div id="popup-root"></div>'

    chrome.sidePanel.open = jest.fn(() => Promise.resolve())
    chrome.sidePanel.setPanelBehavior = jest.fn(() => Promise.resolve())
    window.close = jest.fn()
    global.alert = jest.fn()
  })

  function loadPopup() {
    require('../popup.js')
    document.dispatchEvent(new Event('DOMContentLoaded'))
  }

  it('renders the side panel button', () => {
    loadPopup()

    const button = document.getElementById('openSidePanel')
    expect(button).not.toBeNull()
    expect(button.textContent.trim()).toBe('Open Side Panel')
  })

  it('opens the side panel in the current window when clicked', async () => {
    loadPopup()

    document.getElementById('openSidePanel').click()
    await Promise.resolve()

    expect(chrome.sidePanel.open).toHaveBeenCalledWith({
      windowId: chrome.windows.WINDOW_ID_CURRENT,
    })
  })

  it('closes the popup once the panel is open', async () => {
    loadPopup()

    document.getElementById('openSidePanel').click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(window.close).toHaveBeenCalled()
  })

  it('falls back to enabling the panel on action click when open() is unavailable', async () => {
    chrome.sidePanel.open = jest.fn(() => Promise.reject(new Error('not supported')))
    loadPopup()

    document.getElementById('openSidePanel').click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(chrome.sidePanel.setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: true })
  })
})
