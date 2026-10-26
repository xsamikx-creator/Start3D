const home = document.querySelector('.hero');
const screen = document.getElementById('screen');
const screenContent = document.getElementById('screenContent');
const backBtn = document.getElementById('backBtn');

const screens = {
  order: {
    title: 'Заказать печать',
    text: 'Здесь будет загрузка STL/3MF, выбор материала, количества, качества и рабочий расчёт стоимости.'
  },
  'my-order': {
    title: 'Мой заказ',
    text: 'Здесь будет поиск заказа, этапы выполнения, процент печати, ETA и live-камера.'
  },
  operator: {
    title: 'Панель оператора',
    text: 'Здесь будут новые заявки, проверка цены, очередь и управление четырьмя принтерами.'
  }
};

document.querySelectorAll('[data-screen]').forEach(button => {
  button.addEventListener('click', () => {
    const item = screens[button.dataset.screen];
    home.hidden = true;
    screen.hidden = false;
    screenContent.innerHTML = `
      <div class="placeholder">
        <h2>${item.title}</h2>
        <p>${item.text}</p>
      </div>
    `;
    window.scrollTo({top: 0, behavior: 'smooth'});
  });
});

backBtn.addEventListener('click', () => {
  screen.hidden = true;
  home.hidden = false;
  window.scrollTo({top: 0, behavior: 'smooth'});
});
