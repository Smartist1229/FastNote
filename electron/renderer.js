document.addEventListener('DOMContentLoaded', () => {
    document.addEventListener('click', (event) => {
      const target = event.target;
  
      if (target.tagName === 'A') {
        event.preventDefault();
        const url = target.href;
        window.electron.openExternal(url); // 使用预加载的函数
      }
    });
  });