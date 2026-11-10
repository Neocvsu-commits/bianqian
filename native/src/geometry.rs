use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Monitor, WebviewWindow};

const NOTE_WIDTH: f64 = 640.0;
const NOTE_HEIGHT: f64 = 670.0;
pub const MIN_NOTEBOOK_WIDTH: f64 = 880.0;
pub const MIN_NOTEBOOK_HEIGHT: f64 = 680.0;
const PAPER_OFFSET: f64 = 140.0;
const PAPER_WIDTH: f64 = 360.0;
const PAPER_HEIGHT: f64 = 390.0;
const LEFT_GUTTER: f64 = 70.0;
const TOP_GUTTER: f64 = 41.0;
const BOTTOM_EXTENT: f64 = 446.0;

fn note_width() -> f64 { NOTE_WIDTH }
fn note_height() -> f64 { NOTE_HEIGHT }

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    #[serde(default = "note_width")]
    pub width: f64,
    #[serde(default = "note_height")]
    pub height: f64,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPlacement {
    // Persisted positions use one primary-monitor scale across the desktop.
    // Per-monitor DIP origins would overlap when adjacent scales differ.
    pub logical: Bounds,
    pub canvas: Bounds,
    pub scale: f64,
    pub world_scale: f64,
}

impl DesktopPlacement {
    pub fn paper_origin_physical(&self) -> (f64, f64) {
        (
            (self.logical.x + PAPER_OFFSET) * self.world_scale,
            (self.logical.y + PAPER_OFFSET) * self.world_scale,
        )
    }
}

fn scale(value: f64) -> f64 {
    if value.is_finite() && value > 0.0 { value } else { 1.0 }
}

fn monitor_bounds(monitor: &Monitor) -> Bounds {
    let position = monitor.position();
    let size = monitor.size();
    Bounds { x: position.x as f64, y: position.y as f64,
        width: size.width as f64, height: size.height as f64 }
}

fn work_area(monitor: &Monitor) -> Bounds {
    let area = monitor.work_area();
    Bounds { x: area.position.x as f64, y: area.position.y as f64,
        width: area.size.width as f64, height: area.size.height as f64 }
}

fn distance_squared(bounds: Bounds, x: f64, y: f64) -> f64 {
    let dx = x - x.clamp(bounds.x, bounds.x + bounds.width);
    let dy = y - y.clamp(bounds.y, bounds.y + bounds.height);
    dx * dx + dy * dy
}

struct Displays {
    monitors: Vec<Monitor>,
    primary: Monitor,
    world_scale: f64,
}

impl Displays {
    fn new(app: &AppHandle) -> Result<Self, String> {
        let monitors = app.available_monitors().map_err(|error| error.to_string())?;
        let first = monitors.first().ok_or("No display is available.")?;
        let primary = app.primary_monitor().map_err(|error| error.to_string())?
            .unwrap_or_else(|| first.clone());
        let world_scale = scale(primary.scale_factor());
        Ok(Self { monitors, primary, world_scale })
    }

    fn nearest(&self, x: f64, y: f64) -> &Monitor {
        self.monitors.iter().min_by(|a, b| {
            distance_squared(monitor_bounds(a), x, y)
                .total_cmp(&distance_squared(monitor_bounds(b), x, y))
        }).unwrap_or(&self.primary)
    }

    fn for_paper(&self, x: f64, y: f64) -> &Monitor {
        let at_origin = self.nearest(x, y);
        let factor = scale(at_origin.scale_factor());
        self.nearest(x + PAPER_WIDTH * factor / 2.0, y + PAPER_HEIGHT * factor / 2.0)
    }

    fn fit_paper(&self, monitor: &Monitor, x: f64, y: f64) -> DesktopPlacement {
        let canvas = work_area(monitor);
        let factor = scale(monitor.scale_factor());
        let min_x = canvas.x + LEFT_GUTTER * factor;
        let min_y = canvas.y + TOP_GUTTER * factor;
        let max_x = (canvas.x + canvas.width - PAPER_WIDTH * factor).max(min_x);
        let max_y = (canvas.y + canvas.height - BOTTOM_EXTENT * factor).max(min_y);
        let paper_x = x.clamp(min_x, max_x).round();
        let paper_y = y.clamp(min_y, max_y).round();
        DesktopPlacement {
            logical: Bounds {
                x: paper_x / self.world_scale - PAPER_OFFSET,
                y: paper_y / self.world_scale - PAPER_OFFSET,
                width: NOTE_WIDTH,
                height: NOTE_HEIGHT,
            },
            canvas,
            scale: factor,
            world_scale: self.world_scale,
        }
    }
}

pub fn placement(app: &AppHandle, position: Option<Bounds>) -> Result<DesktopPlacement, String> {
    let displays = Displays::new(app)?;
    if let Some(position) = position {
        if !position.x.is_finite() || !position.y.is_finite() {
            return Err("The note position is invalid.".into());
        }
        let x = (position.x + PAPER_OFFSET) * displays.world_scale;
        let y = (position.y + PAPER_OFFSET) * displays.world_scale;
        Ok(displays.fit_paper(displays.for_paper(x, y), x, y))
    } else {
        let area = work_area(&displays.primary);
        let factor = scale(displays.primary.scale_factor());
        let x = area.x + (area.width - (PAPER_WIDTH + LEFT_GUTTER) * factor) / 2.0
            + LEFT_GUTTER * factor;
        let y = area.y + (area.height - (TOP_GUTTER + BOTTOM_EXTENT) * factor) / 2.0
            + TOP_GUTTER * factor;
        Ok(displays.fit_paper(&displays.primary, x, y))
    }
}

// A completed native drag already has the right visible position. Preserve its
// client surface instead of moving the HWND and compensating later in the DOM.
pub fn retain_canvas(window: &WebviewWindow, paper_x: f64, paper_y: f64) -> Result<DesktopPlacement, String> {
    let origin = window.inner_position().map_err(|error| error.to_string())?;
    let size = window.inner_size().map_err(|error| error.to_string())?;
    let factor = scale(window.scale_factor().map_err(|error| error.to_string())?);
    let world_scale = window.primary_monitor().map_err(|error| error.to_string())?
        .map(|monitor| scale(monitor.scale_factor())).unwrap_or(factor);
    Ok(DesktopPlacement {
        logical: Bounds {
            x: (origin.x as f64 + paper_x * factor) / world_scale - PAPER_OFFSET,
            y: (origin.y as f64 + paper_y * factor) / world_scale - PAPER_OFFSET,
            width: NOTE_WIDTH,
            height: NOTE_HEIGHT,
        },
        canvas: Bounds { x: origin.x as f64, y: origin.y as f64, width: size.width as f64, height: size.height as f64 },
        scale: factor,
        world_scale,
    })
}

pub fn layout(placement: &DesktopPlacement) -> Value {
    let (x, y) = placement.paper_origin_physical();
    json!({
        "paperX": (x - placement.canvas.x) / placement.scale,
        "paperY": (y - placement.canvas.y) / placement.scale,
        "viewportWidth": placement.canvas.width / placement.scale,
        "viewportHeight": placement.canvas.height / placement.scale,
    })
}

pub fn cursor(window: &WebviewWindow) -> Result<Value, String> {
    let point = window.cursor_position().map_err(|error| error.to_string())?;
    let origin = window.inner_position().map_err(|error| error.to_string())?;
    let factor = scale(window.scale_factor().map_err(|error| error.to_string())?);
    let world_scale = window.primary_monitor().map_err(|error| error.to_string())?
        .map(|monitor| scale(monitor.scale_factor())).unwrap_or(factor);
    Ok(json!({
        "x": point.x / world_scale,
        "y": point.y / world_scale,
        "clientX": (point.x - origin.x as f64) / factor,
        "clientY": (point.y - origin.y as f64) / factor,
        "physicalX": point.x,
        "physicalY": point.y,
        "scale": factor,
        "worldScale": world_scale,
    }))
}

pub fn notebook_bounds(mut bounds: Bounds) -> Bounds {
    // Older builds saved the desktop note size over the notebook's bounds.
    if bounds.width == NOTE_WIDTH && bounds.height == NOTE_HEIGHT {
        bounds.width = 1120.0;
        bounds.height = 850.0;
    }
    bounds.width = bounds.width.max(MIN_NOTEBOOK_WIDTH);
    bounds.height = bounds.height.max(MIN_NOTEBOOK_HEIGHT);
    bounds
}

// Position uses the same world space as notes; width/height remain CSS dimensions.
pub fn normal_physical(app: &AppHandle, bounds: Bounds) -> Result<Bounds, String> {
    if ![bounds.x, bounds.y, bounds.width, bounds.height].iter().all(|value| value.is_finite())
        || bounds.width <= 0.0 || bounds.height <= 0.0 {
        return Err("The window bounds are invalid.".into());
    }
    let bounds = notebook_bounds(bounds);
    let displays = Displays::new(app)?;
    let x = bounds.x * displays.world_scale;
    let y = bounds.y * displays.world_scale;
    let initial = displays.nearest(x, y);
    let initial_scale = scale(initial.scale_factor());
    let monitor = displays.nearest(x + bounds.width * initial_scale / 2.0,
        y + bounds.height * initial_scale / 2.0);
    let factor = scale(monitor.scale_factor());
    let area = work_area(monitor);
    let width = (bounds.width * factor).round().min(area.width).max(1.0);
    let height = (bounds.height * factor).round().min(area.height).max(1.0);
    Ok(Bounds {
        x: x.clamp(area.x, (area.x + area.width - width).max(area.x)).round(),
        y: y.clamp(area.y, (area.y + area.height - height).max(area.y)).round(),
        width,
        height,
    })
}

pub fn normal_logical(window: &WebviewWindow) -> Result<Bounds, String> {
    let origin = window.outer_position().map_err(|error| error.to_string())?;
    let size = window.inner_size().map_err(|error| error.to_string())?;
    let factor = scale(window.scale_factor().map_err(|error| error.to_string())?);
    let world_scale = window.primary_monitor().map_err(|error| error.to_string())?
        .map(|monitor| scale(monitor.scale_factor())).unwrap_or(factor);
    Ok(Bounds {
        x: origin.x as f64 / world_scale,
        y: origin.y as f64 / world_scale,
        width: size.width as f64 / factor,
        height: size.height as f64 / factor,
    })
}
