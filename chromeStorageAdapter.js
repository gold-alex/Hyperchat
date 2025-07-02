// Chrome storage adapter for Supabase auth
export const chromeStorageAdapter = {
  async getItem(key) {
    return new Promise(resolve => {
      chrome.storage.local.get([key], data => {
        resolve(data[key] ?? null);
      });
    });
  },
  
  async setItem(key, value) {
    return new Promise(resolve => {
      chrome.storage.local.set({ [key]: value }, () => {
        resolve();
      });
    });
  },
  
  async removeItem(key) {
    return new Promise(resolve => {
      chrome.storage.local.remove([key], () => {
        resolve();
      });
    });
  }
}; 