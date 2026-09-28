'use strict';
const frame=document.querySelector('#preview'),screen=document.querySelector('#screen'),direct=document.querySelector('#direct');
screen.addEventListener('change',()=>{frame.src=screen.value+'.html';direct.href=frame.src});
document.querySelectorAll('[data-width]').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('[data-width]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)));frame.classList.toggle('device',b.dataset.width!=='desktop');frame.style.width=b.dataset.width==='desktop'?'100%':b.dataset.width+'px'}));
frame.addEventListener('load',()=>{try{const name=frame.contentWindow.location.pathname.split('/').pop().replace('.html','');if([...screen.options].some(o=>o.value===name))screen.value=name;direct.href=frame.contentWindow.location.href}catch{/* file:// browsers may isolate iframe origins. */}});
