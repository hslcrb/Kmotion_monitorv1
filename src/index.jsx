import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { Play, Pause, Download, MonitorPlay, Type, Square, Circle, Trash2, Layers, Settings } from 'lucide-react';

// ============================================================================
// [1] CORE ENGINE: 가상 시간 및 비디오 컨텍스트 (Virtual Time Engine)
// ============================================================================
const EngineContext = createContext({
  frame: 0,
  fps: 30,
  durationInFrames: 150, // 기본 5초
  width: 800,
  height: 450,
});

// 사용자가 컴포넌트 내에서 현재 프레임을 가져오는 Hook (리모션의 useCurrentFrame과 동일)
export const useCurrentFrame = () => {
  return useContext(EngineContext).frame;
};

// 사용자가 비디오 설정값을 가져오는 Hook
export const useVideoConfig = () => {
  return useContext(EngineContext);
};

// ============================================================================
// [2] MATH & UTILS: 보간법 (Interpolation) 엔진
// 애니메이션을 부드럽게 만들기 위한 핵심 수학 함수입니다.
// ============================================================================
export const interpolate = (input, inputRange, outputRange, options = {}) => {
  const { extrapolateLeft = 'clamp', extrapolateRight = 'clamp' } = options;
  const [inMin, inMax] = inputRange;
  const [outMin, outMax] = outputRange;

  let val = input;
  // Extrapolation (범위 밖의 값 처리)
  if (val < inMin) val = extrapolateLeft === 'clamp' ? inMin : val;
  if (val > inMax) val = extrapolateRight === 'clamp' ? inMax : val;

  // 선형 보간 (Linear Interpolation)
  const percentage = (val - inMin) / (inMax - inMin);
  return outMin + percentage * (outMax - outMin);
};

// ============================================================================
// [3] DYNAMIC SCENE: 상태 기반 렌더러 (비디오 편집기 뷰어)
// ============================================================================
const DynamicScene = ({ elements, selectedId, width, height, frame }) => {
  return (
    <svg width={width} height={height} xmlns="http://www.w3.org/2000/svg" style={{ backgroundColor: '#1f2937' }}>
      {elements.map(el => {
        // 타임라인 상 나타나는 구간 필터링 (해당 프레임이 아니면 렌더링하지 않음)
        if (frame < el.startFrame || frame >= el.startFrame + el.duration) return null;
        
        // 선택된 요소의 바운딩 박스(테두리 하이라이트) 계산
        const isSelected = el.id === selectedId;
        let bbox = { x: 0, y: 0, w: 0, h: 0 };
        if (el.type === 'rect') bbox = { x: el.x, y: el.y, w: el.width, h: el.height };
        if (el.type === 'circle') bbox = { x: el.x - el.radius, y: el.y - el.radius, w: el.radius * 2, h: el.radius * 2 };
        if (el.type === 'text') bbox = { x: el.x - 100, y: el.y - el.fontSize, w: 200, h: el.fontSize * 1.5 }; // 대략적인 텍스트 박스
        
        const outline = isSelected ? (
          <rect x={bbox.x - 5} y={bbox.y - 5} width={bbox.w + 10} height={bbox.h + 10} fill="none" stroke="#3b82f6" strokeWidth="2" strokeDasharray="4" />
        ) : null;

        if (el.type === 'text') {
          return (
            <g key={el.id}>
              {outline}
              <text x={el.x} y={el.y} fill={el.color} fontSize={el.fontSize} fontFamily="sans-serif" textAnchor="middle" fontWeight="bold">
                {el.text}
              </text>
            </g>
          );
        }
        if (el.type === 'rect') {
          return <g key={el.id}>{outline}<rect x={el.x} y={el.y} width={el.width} height={el.height} fill={el.color} rx="8" /></g>;
        }
        if (el.type === 'circle') {
          return <g key={el.id}>{outline}<circle cx={el.x} cy={el.y} r={el.radius} fill={el.color} /></g>;
        }
        return null;
      })}
    </svg>
  );
};

// ============================================================================
// [4] MAIN ENGINE RENDERER & UI: 종합 비디오 편집기 인터페이스
// ============================================================================
export default function App() {
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  
  // 영상 기본 설정
  const config = {
    fps: 30,
    durationInFrames: 150, // 5초
    width: 800,
    height: 450,
  };

  // === 편집기 전용 상태 (동영상 클립 및 도형들) ===
  const [elements, setElements] = useState([
    { id: 1, type: 'text', text: '안녕! K-Motion Editor', x: 400, y: 225, startFrame: 0, duration: 90, color: '#ffffff', fontSize: 48 },
    { id: 2, type: 'circle', radius: 60, x: 200, y: 225, startFrame: 30, duration: 100, color: '#ec4899' },
    { id: 3, type: 'rect', width: 120, height: 120, x: 540, y: 165, startFrame: 60, duration: 80, color: '#8b5cf6' }
  ]);
  const [selectedId, setSelectedId] = useState(null);

  // 내부 로직용 Refs
  const svgRef = useRef(null);
  const canvasRef = useRef(null);
  const frameRef = useRef(0);
  const playingRef = useRef(false);
  const exportingRef = useRef(false);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);

  // 최신 상태 동기화
  useEffect(() => { frameRef.current = frame; }, [frame]);
  useEffect(() => { playingRef.current = playing; }, [playing]);
  useEffect(() => { exportingRef.current = isExporting; }, [isExporting]);

  // [엔진 로직 1] SVG를 Canvas로 전송하여 비디오로 추출할 준비
  const syncSvgToCanvas = useCallback(() => {
    if (!svgRef.current || !canvasRef.current) return;
    const svgElement = svgRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');

    const xml = new XMLSerializer().serializeToString(svgElement);
    const svg64 = btoa(unescape(encodeURIComponent(xml)));
    const image64 = `data:image/svg+xml;base64,${svg64}`;

    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, config.width, config.height);
      ctx.drawImage(img, 0, 0);
    };
    img.src = image64;
  }, [config.width, config.height]);

  // [엔진 로직 2] 재생 스케줄러 (루프)
  useEffect(() => {
    let animationFrameId;
    let lastTime = performance.now();

    const loop = (time) => {
      if (playingRef.current) {
        const deltaTime = time - lastTime;
        const frameDuration = 1000 / config.fps;

        if (deltaTime >= frameDuration) {
          let nextFrame = frameRef.current + 1;
          
          if (nextFrame >= config.durationInFrames) {
            setPlaying(false);
            nextFrame = 0; 
            
            if (exportingRef.current && mediaRecorderRef.current) {
              mediaRecorderRef.current.stop();
              setIsExporting(false);
            }
          } else {
            setFrame(nextFrame);
          }
          lastTime = time - (deltaTime % frameDuration);
        }
      }
      
      syncSvgToCanvas();
      animationFrameId = requestAnimationFrame(loop);
    };

    animationFrameId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animationFrameId);
  }, [config.fps, config.durationInFrames, syncSvgToCanvas]);

  // [엔진 로직 3] 비디오 파일 굽기 (Export)
  const startExport = async () => {
    if (isExporting) return;
    
    setIsExporting(true);
    setFrame(0);
    setPlaying(false);
    chunksRef.current = [];

    const stream = canvasRef.current.captureStream(config.fps);
    const options = { mimeType: 'video/webm; codecs=vp9' };
    const mediaRecorder = new MediaRecorder(stream, options);
    
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    mediaRecorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `kmotion-editor-${Date.now()}.webm`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    };

    mediaRecorderRef.current = mediaRecorder;
    
    setTimeout(() => {
      mediaRecorder.start();
      setPlaying(true);
    }, 500);
  };

  const togglePlay = () => setPlaying(!playing);
  const handleSeek = (e) => {
    setFrame(Number(e.target.value));
    setPlaying(false);
  };

  // === 편집기 기능 액션 ===
  const addElement = (type) => {
    const newEl = {
      id: Date.now(),
      type,
      x: config.width / 2,
      y: config.height / 2,
      startFrame: frame, // 현재 재생 헤드가 위치한 시간부터 등장
      duration: 60,
      color: type === 'text' ? '#ffffff' : type === 'rect' ? '#3b82f6' : '#10b981',
      ...(type === 'text' && { text: '새로운 텍스트', fontSize: 40 }),
      ...(type === 'rect' && { width: 100, height: 100 }),
      ...(type === 'circle' && { radius: 50 }),
    };
    setElements([...elements, newEl]);
    setSelectedId(newEl.id);
  };

  const updateElement = (id, field, value) => {
    setElements(elements.map(el => el.id === id ? { ...el, [field]: value } : el));
  };

  const deleteElement = (id) => {
    setElements(elements.filter(el => el.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const selectedElement = elements.find(el => el.id === selectedId);

  return (
    <EngineContext.Provider value={{ ...config, frame }}>
      <div className="h-screen bg-gray-950 text-white flex flex-col font-sans overflow-hidden">
        
        {/* 상단 헤더 */}
        <div className="flex justify-between items-center px-6 py-4 border-b border-gray-800 bg-gray-900 shrink-0">
          <div className="flex items-center space-x-3">
            <MonitorPlay className="w-7 h-7 text-blue-500" />
            <h1 className="text-xl font-bold tracking-tight">K-Motion Editor</h1>
          </div>
          <button 
            onClick={startExport}
            disabled={isExporting}
            className={`flex items-center space-x-2 px-5 py-2 rounded-lg font-semibold transition-all shadow-lg
              ${isExporting ? 'bg-red-500 animate-pulse cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-500 hover:scale-105'}`}
          >
            <Download className="w-4 h-4" />
            <span>{isExporting ? '렌더링 진행 중...' : '비디오 내보내기'}</span>
          </button>
        </div>

        {/* 중앙 워크스페이스 (툴바 + 캔버스 + 속성창) */}
        <div className="flex-1 flex overflow-hidden">
          
          {/* 왼쪽 툴바 (요소 추가) */}
          <div className="w-20 bg-gray-900 border-r border-gray-800 flex flex-col items-center py-6 space-y-6 shrink-0">
            <button onClick={() => addElement('text')} className="p-3 bg-gray-800 hover:bg-gray-700 rounded-xl text-gray-300 hover:text-white transition group relative">
              <Type className="w-6 h-6" />
              <span className="absolute left-14 bg-gray-800 px-2 py-1 rounded text-xs opacity-0 group-hover:opacity-100 whitespace-nowrap pointer-events-none transition z-50">텍스트 추가</span>
            </button>
            <button onClick={() => addElement('rect')} className="p-3 bg-gray-800 hover:bg-gray-700 rounded-xl text-gray-300 hover:text-white transition group relative">
              <Square className="w-6 h-6" />
              <span className="absolute left-14 bg-gray-800 px-2 py-1 rounded text-xs opacity-0 group-hover:opacity-100 whitespace-nowrap pointer-events-none transition z-50">사각형 추가</span>
            </button>
            <button onClick={() => addElement('circle')} className="p-3 bg-gray-800 hover:bg-gray-700 rounded-xl text-gray-300 hover:text-white transition group relative">
              <Circle className="w-6 h-6" />
              <span className="absolute left-14 bg-gray-800 px-2 py-1 rounded text-xs opacity-0 group-hover:opacity-100 whitespace-nowrap pointer-events-none transition z-50">원 추가</span>
            </button>
          </div>

          {/* 메인 캔버스 뷰포트 */}
          <div className="flex-1 flex flex-col relative bg-gray-950 p-6 overflow-y-auto" onClick={() => setSelectedId(null)}>
            <div className="flex-1 flex justify-center items-center">
              {/* 실제 영상 규격 사이즈의 래퍼 */}
              <div 
                className="relative shadow-[0_0_40px_rgba(0,0,0,0.5)] border border-gray-700 rounded-lg overflow-hidden shrink-0" 
                style={{ width: config.width, height: config.height }}
                onClick={(e) => e.stopPropagation()} // 클릭 이벤트 전파 차단
              >
                
                <div ref={svgRef} className="absolute inset-0 flex justify-center items-center select-none">
                  <DynamicScene elements={elements} selectedId={selectedId} width={config.width} height={config.height} frame={frame} />
                </div>

                {/* 비디오 캡처용 숨겨진 캔버스 */}
                <canvas ref={canvasRef} width={config.width} height={config.height} className="absolute opacity-0 pointer-events-none" />
                
                {isExporting && (
                  <div className="absolute top-4 right-4 bg-red-600 text-xs font-bold px-3 py-1 rounded-full flex items-center space-x-2 animate-pulse">
                    <div className="w-2 h-2 bg-white rounded-full"></div>
                    <span>REC</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* 오른쪽 속성 패널 (Inspector) */}
          <div className="w-72 bg-gray-900 border-l border-gray-800 flex flex-col shrink-0">
            <div className="p-4 border-b border-gray-800 flex items-center space-x-2">
              <Settings className="w-5 h-5 text-gray-400" />
              <h2 className="font-semibold text-sm">속성 (Properties)</h2>
            </div>
            
            <div className="p-4 flex-1 overflow-y-auto">
              {selectedElement ? (
                <div className="space-y-5">
                  {/* 공통 속성 */}
                  <div className="space-y-3">
                    <div className="flex justify-between items-center">
                      <span className="text-xs text-gray-400 uppercase font-bold tracking-wider">위치 및 색상</span>
                      <button onClick={() => deleteElement(selectedElement.id)} className="text-red-400 hover:text-red-300 p-1" title="요소 삭제">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                    
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-xs text-gray-500 mb-1 block">X 좌표</label>
                        <input type="number" value={selectedElement.x} onChange={(e) => updateElement(selectedElement.id, 'x', Number(e.target.value))} className="w-full bg-gray-800 border border-gray-700 rounded p-1.5 text-sm outline-none focus:border-blue-500" />
                      </div>
                      <div>
                        <label className="text-xs text-gray-500 mb-1 block">Y 좌표</label>
                        <input type="number" value={selectedElement.y} onChange={(e) => updateElement(selectedElement.id, 'y', Number(e.target.value))} className="w-full bg-gray-800 border border-gray-700 rounded p-1.5 text-sm outline-none focus:border-blue-500" />
                      </div>
                    </div>

                    <div>
                      <label className="text-xs text-gray-500 mb-1 block">색상 (Color)</label>
                      <div className="flex space-x-2 items-center">
                        <input type="color" value={selectedElement.color} onChange={(e) => updateElement(selectedElement.id, 'color', e.target.value)} className="w-8 h-8 rounded cursor-pointer bg-transparent border-none p-0" />
                        <input type="text" value={selectedElement.color} onChange={(e) => updateElement(selectedElement.id, 'color', e.target.value)} className="flex-1 bg-gray-800 border border-gray-700 rounded p-1.5 text-sm font-mono outline-none focus:border-blue-500" />
                      </div>
                    </div>
                  </div>

                  <div className="h-px bg-gray-800 my-4"></div>

                  {/* 타입별 고유 속성 */}
                  <div className="space-y-3">
                    <span className="text-xs text-gray-400 uppercase font-bold tracking-wider">{selectedElement.type === 'text' ? '텍스트 설정' : '모양 설정'}</span>
                    
                    {selectedElement.type === 'text' && (
                      <>
                        <div>
                          <label className="text-xs text-gray-500 mb-1 block">내용</label>
                          <input type="text" value={selectedElement.text} onChange={(e) => updateElement(selectedElement.id, 'text', e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded p-1.5 text-sm outline-none focus:border-blue-500" />
                        </div>
                        <div>
                          <label className="text-xs text-gray-500 mb-1 block">글자 크기 (px)</label>
                          <input type="number" value={selectedElement.fontSize} onChange={(e) => updateElement(selectedElement.id, 'fontSize', Number(e.target.value))} className="w-full bg-gray-800 border border-gray-700 rounded p-1.5 text-sm outline-none focus:border-blue-500" />
                        </div>
                      </>
                    )}

                    {selectedElement.type === 'rect' && (
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-xs text-gray-500 mb-1 block">너비 (Width)</label>
                          <input type="number" value={selectedElement.width} onChange={(e) => updateElement(selectedElement.id, 'width', Number(e.target.value))} className="w-full bg-gray-800 border border-gray-700 rounded p-1.5 text-sm outline-none focus:border-blue-500" />
                        </div>
                        <div>
                          <label className="text-xs text-gray-500 mb-1 block">높이 (Height)</label>
                          <input type="number" value={selectedElement.height} onChange={(e) => updateElement(selectedElement.id, 'height', Number(e.target.value))} className="w-full bg-gray-800 border border-gray-700 rounded p-1.5 text-sm outline-none focus:border-blue-500" />
                        </div>
                      </div>
                    )}

                    {selectedElement.type === 'circle' && (
                      <div>
                        <label className="text-xs text-gray-500 mb-1 block">반지름 (Radius)</label>
                        <input type="number" value={selectedElement.radius} onChange={(e) => updateElement(selectedElement.id, 'radius', Number(e.target.value))} className="w-full bg-gray-800 border border-gray-700 rounded p-1.5 text-sm outline-none focus:border-blue-500" />
                      </div>
                    )}
                  </div>
                  
                  <div className="h-px bg-gray-800 my-4"></div>
                  
                  {/* 시간 (타임라인) 속성 */}
                  <div className="space-y-3">
                    <span className="text-xs text-gray-400 uppercase font-bold tracking-wider">시간 설정 (Frames)</span>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-xs text-gray-500 mb-1 block">등장 시점</label>
                        <input type="number" value={selectedElement.startFrame} onChange={(e) => updateElement(selectedElement.id, 'startFrame', Number(e.target.value))} className="w-full bg-gray-800 border border-gray-700 rounded p-1.5 text-sm outline-none focus:border-blue-500" />
                      </div>
                      <div>
                        <label className="text-xs text-gray-500 mb-1 block">지속 시간</label>
                        <input type="number" value={selectedElement.duration} onChange={(e) => updateElement(selectedElement.id, 'duration', Number(e.target.value))} className="w-full bg-gray-800 border border-gray-700 rounded p-1.5 text-sm outline-none focus:border-blue-500" />
                      </div>
                    </div>
                  </div>

                </div>
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-gray-500 space-y-3">
                  <Layers className="w-12 h-12 opacity-20" />
                  <p className="text-sm text-center">캔버스나 타임라인에서<br/>요소를 선택해주세요.</p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 하단 멀티 트랙 타임라인 패널 */}
        <div className="h-64 bg-gray-900 border-t border-gray-800 flex flex-col shrink-0">
          
          {/* 타임라인 컨트롤 헤더 */}
          <div className="h-12 border-b border-gray-800 flex items-center px-4 space-x-4 bg-gray-950 shrink-0">
            <button 
              onClick={togglePlay}
              disabled={isExporting}
              className={`p-1.5 rounded-md flex items-center justify-center transition-colors
                ${isExporting ? 'text-gray-600' : 'text-gray-300 hover:text-white hover:bg-gray-800'}`}
            >
              {playing ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
            </button>
            
            <div className="flex-1 relative flex items-center group">
              <div className="absolute w-full h-1 bg-gray-800 rounded pointer-events-none"></div>
              {/* 진행 바 */}
              <div className="absolute h-1 bg-blue-500 rounded pointer-events-none" style={{ width: `${(frame / (config.durationInFrames - 1)) * 100}%` }}></div>
              {/* 스크러버(재생 헤드 컨트롤) */}
              <input 
                type="range" 
                min="0" 
                max={config.durationInFrames - 1} 
                value={frame}
                onChange={handleSeek}
                disabled={isExporting}
                className="w-full h-4 appearance-none bg-transparent cursor-pointer z-10 
                         [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
              />
            </div>
            
            <div className="text-xs font-mono text-gray-400 bg-gray-800 px-2 py-1 rounded border border-gray-700">
              {String(frame).padStart(3, '0')} / {config.durationInFrames}
            </div>
          </div>

          {/* 타임라인 트랙 리스트 */}
          <div className="flex-1 overflow-y-auto p-2 space-y-1 relative bg-gray-900">
            {/* 현재 프레임 표시선 (수직 빨간 선) */}
            <div 
              className="absolute top-0 bottom-0 w-px bg-red-500 z-20 pointer-events-none"
              style={{ left: `calc(${((frame / config.durationInFrames) * 100)}% + 1rem)` }} // 대략적인 여백 보정
            >
              <div className="w-3 h-3 bg-red-500 rotate-45 -translate-x-[5px] -translate-y-1.5 rounded-sm"></div>
            </div>

            {/* 개별 요소 트랙 렌더링 */}
            {elements.map((el) => (
              <div key={el.id} className="flex items-center h-10 group cursor-pointer" onClick={() => setSelectedId(el.id)}>
                {/* 트랙 이름 영역 */}
                <div className="w-32 flex items-center space-x-2 px-2 text-xs text-gray-400 bg-gray-800 h-full border-r border-gray-700 rounded-l-md truncate shrink-0">
                  {el.type === 'text' ? <Type className="w-3 h-3" /> : el.type === 'rect' ? <Square className="w-3 h-3" /> : <Circle className="w-3 h-3" />}
                  <span className="truncate">{el.type === 'text' ? el.text : el.type.toUpperCase()}</span>
                </div>
                
                {/* 트랙 지속시간 클립 영역 */}
                <div className="flex-1 h-full bg-gray-950 relative rounded-r-md border border-gray-800 border-l-0 overflow-hidden">
                  <div 
                    className={`absolute top-1.5 bottom-1.5 rounded text-[10px] px-2 flex items-center font-bold text-white shadow-sm transition-all
                      ${selectedId === el.id ? 'bg-blue-600 ring-1 ring-white z-10' : 'bg-gray-700 hover:bg-gray-600'}`}
                    style={{ 
                      left: `${(el.startFrame / config.durationInFrames) * 100}%`, 
                      width: `${(el.duration / config.durationInFrames) * 100}%` 
                    }}
                  >
                     <span className="truncate w-full block text-center opacity-80">{el.duration}f</span>
                  </div>
                </div>
              </div>
            ))}
            
            {elements.length === 0 && (
              <div className="h-full flex items-center justify-center text-gray-600 text-sm">
                좌측 툴바에서 텍스트나 도형을 추가하여 트랙을 생성하세요.
              </div>
            )}
          </div>

        </div>

      </div>
    </EngineContext.Provider>
  );
}
