/* Independent presentation preview. All assets travel with the offline app. */
(() => {
  'use strict';
  const project = SIDE_PROJECT;
  const banner = document.getElementById('sideProjectBanner');
  if (!banner) return;
  banner.innerHTML = `<div class="side-project-inner">
    <div class="side-project-copy"><span class="side-project-label">Side project</span>
      <div><strong id="sideProjectName"></strong><p id="sideProjectDescription"></p></div>
    </div>
    <button id="sideProjectOpen" aria-haspopup="dialog" aria-controls="sideProjectDialog">Explore side project <span aria-hidden="true">→</span></button>
  </div>`;
  document.getElementById('sideProjectName').textContent = project.title;
  document.getElementById('sideProjectDescription').textContent = project.description;

  const dialog = document.createElement('dialog');
  dialog.id = 'sideProjectDialog';
  dialog.className = 'side-project-dialog';
  dialog.setAttribute('aria-labelledby', 'sideProjectTitle');
  dialog.setAttribute('aria-describedby', 'sideProjectSummary');
  dialog.innerHTML = `<div class="dialog-head">
    <div><span class="side-project-label">Side project</span><h2 id="sideProjectTitle"></h2></div>
    <button id="sideProjectClose" aria-label="Close side project" autofocus>×</button>
  </div><div class="side-project-body">
    <p id="sideProjectSummary" class="side-project-summary"></p>
    <div class="side-project-download"><button id="sideProjectDownload" class="primary">Download original slides (.pptx)</button><span id="sideProjectSlideCount"></span></div>
    <div id="sideProjectSections" class="side-project-sections"></div>
    <figure><img id="sideProjectPreview" alt="Presentation figure showing a quarterback pressure example alongside simulated fly-circuit activity"><figcaption id="sideProjectCaption"></figcaption></figure>
    <p class="side-project-separation">Independent exploratory project. Coverage Lift’s metric and validation are separate.</p>
    <p id="sideProjectDownloadStatus" class="sr-only" role="status"></p>
  </div>`;
  document.body.append(dialog);
  document.getElementById('sideProjectTitle').textContent = project.title;
  document.getElementById('sideProjectSummary').textContent = project.summary;
  document.getElementById('sideProjectSlideCount').textContent = `${project.slideCount} slides · Included offline`;
  document.getElementById('sideProjectPreview').src = project.previewDataUrl;
  document.getElementById('sideProjectCaption').textContent = project.previewCaption;
  for (const section of project.sections) {
    const item = document.createElement('section');
    const title = document.createElement('h3');
    const description = document.createElement('p');
    title.textContent = section.title;
    description.textContent = section.description;
    item.append(title, description);
    document.getElementById('sideProjectSections').append(item);
  }
  const openButton = document.getElementById('sideProjectOpen');
  let resumePlayback = false;
  openButton.addEventListener('click', () => {
    const app = window.OpenFieldApp;
    resumePlayback = Boolean(app?.state.playing);
    app?.pause();
    dialog.showModal();
  });
  document.getElementById('sideProjectClose').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    openButton.focus({ preventScroll: true });
    if (resumePlayback) window.OpenFieldApp?.play();
    resumePlayback = false;
  });
  document.getElementById('sideProjectDownload').addEventListener('click', () => {
    const bytes = Uint8Array.from(atob(project.presentationBase64), character => character.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = project.presentation;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    document.getElementById('sideProjectDownloadStatus').textContent = 'The original PowerPoint download has started.';
  });
  banner.hidden = false;
})();
