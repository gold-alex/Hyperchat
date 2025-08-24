// Debug script to test message signing flow
// Run this in the Chrome DevTools console of the sidepanel

async function debugSignatureFlow() {
    console.log('=== DEBUGGING SIGNATURE FLOW ===');
    
    // 1. Check if we have a wallet address
    console.log('1. Wallet address:', walletAddress);
    if (!walletAddress) {
        console.error('❌ No wallet address - need to connect wallet first');
        return;
    }
    
    // 2. Check if we can find the Hyperliquid tab
    console.log('2. Looking for Hyperliquid tab...');
    const tabs = await chrome.tabs.query({ url: "*://app.hyperliquid.xyz/trade*" });
    console.log('   Found tabs:', tabs.length);
    if (tabs.length === 0) {
        console.error('❌ No Hyperliquid tabs found');
        return;
    }
    
    const tab = tabs[0];
    console.log('   Using tab:', tab.id, tab.url);
    
    // 3. Test basic communication with content script
    console.log('3. Testing basic communication...');
    try {
        const roomResponse = await chrome.tabs.sendMessage(tab.id, { action: 'getCurrentRoom' });
        console.log('   ✅ Content script responded:', roomResponse);
    } catch (error) {
        console.error('   ❌ Content script not responding:', error);
        return;
    }
    
    // 4. Test signing a message
    console.log('4. Testing message signing...');
    const timestamp = Date.now();
    const content = "Test message";
    const dataToSign = JSON.stringify({ timestamp, content });
    
    console.log('   Sending signMessage request with:', dataToSign);
    
    try {
        const response = await new Promise((resolve, reject) => {
            chrome.tabs.sendMessage(tab.id, {
                action: 'signMessage',
                message: dataToSign
            }, (response) => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                } else {
                    resolve(response);
                }
            });
        });
        
        console.log('   Response from content script:', response);
        
        if (response && response.signature) {
            console.log('   ✅ Got signature:', response.signature);
        } else if (response && response.error) {
            console.error('   ❌ Error from content script:', response.error);
        } else {
            console.error('   ❌ Invalid response:', response);
        }
    } catch (error) {
        console.error('   ❌ Failed to communicate:', error);
    }
    
    // 5. Check if ethereum is available in content script
    console.log('5. Checking ethereum availability in content script...');
    try {
        const ethCheck = await chrome.tabs.sendMessage(tab.id, { 
            action: 'debugEthereum' 
        });
        console.log('   Ethereum check response:', ethCheck);
    } catch (error) {
        console.log('   No debugEthereum handler (expected)');
    }
    
    console.log('=== DEBUG COMPLETE ===');
}

// Run the debug
debugSignatureFlow();

// Also add a manual test function
window.testSignMessage = async function(message = "Test message") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    console.log('Sending to tab:', tab.id);
    
    const response = await chrome.tabs.sendMessage(tab.id, {
        action: 'signMessage',
        message: message
    });
    
    console.log('Response:', response);
    return response;
}