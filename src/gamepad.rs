// Native gamepad input for desktop platforms.
//
// The UI consumes the Web Gamepad "standard" layout.  gilrs gives us one
// normalized API over XInput/DirectInput (Windows), evdev (Linux), and IOKit
// (macOS), so the frontend does not have to depend on a WebView Gamepad API.

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use gilrs::{Axis, Button, Gamepad, Gilrs};

use crate::GamepadSnapshot;

fn button_index(button: Button) -> Option<usize> {
    Some(match button {
        Button::South => 0,
        Button::East => 1,
        // W3C standard: 2 = X (left face), 3 = Y (top face).
        Button::West => 2,
        Button::North => 3,
        // gilrs names the bumpers Trigger/Trigger2; map them to the
        // standard Web Gamepad slots (LB/RB=4/5, LT/RT=6/7).
        Button::LeftTrigger => 4,
        Button::RightTrigger => 5,
        Button::LeftTrigger2 => 6,
        Button::RightTrigger2 => 7,
        Button::Select => 8,
        Button::Start => 9,
        Button::LeftThumb => 10,
        Button::RightThumb => 11,
        Button::DPadUp => 12,
        Button::DPadDown => 13,
        Button::DPadLeft => 14,
        Button::DPadRight => 15,
        Button::Mode => 16,
        _ => return None,
    })
}

fn w3c_stick_y(value: f32) -> f32 {
    -value
}

fn fill_snapshot(gamepad: &Gamepad, snapshot: &mut GamepadSnapshot) {
    snapshot.connected = true;
    snapshot.id = gamepad.name().to_string();

    // gilrs uses positive-up for stick Y; the W3C Gamepad standard used by
    // the UI uses negative-up, so invert both Y axes.
    snapshot.axes = [
        gamepad.value(Axis::LeftStickX),
        w3c_stick_y(gamepad.value(Axis::LeftStickY)),
        gamepad.value(Axis::RightStickX),
        w3c_stick_y(gamepad.value(Axis::RightStickY)),
    ];

    for button in [
        Button::South,
        Button::East,
        Button::North,
        Button::West,
        Button::LeftTrigger,
        Button::RightTrigger,
        Button::LeftTrigger2,
        Button::RightTrigger2,
        Button::Select,
        Button::Start,
        Button::LeftThumb,
        Button::RightThumb,
        Button::DPadUp,
        Button::DPadDown,
        Button::DPadLeft,
        Button::DPadRight,
        Button::Mode,
    ] {
        if let Some(index) = button_index(button) {
            snapshot.buttons[index] = gamepad.is_pressed(button);
        }
    }
}

fn run(state: Arc<Mutex<GamepadSnapshot>>) {
    let mut gilrs = match Gilrs::new() {
        Ok(gilrs) => gilrs,
        Err(e) => {
            if let Ok(mut snapshot) = state.lock() {
                *snapshot = GamepadSnapshot::default();
            }
            eprintln!("native gamepad unavailable: {e}");
            return;
        }
    };

    loop {
        // Drain events so hotplug/disconnect updates are observed.  The
        // current state is sampled below for every frame.
        while gilrs.next_event().is_some() {}

        let mut snapshot = GamepadSnapshot {
            available: true,
            ..GamepadSnapshot::default()
        };

        if let Some((_id, gamepad)) = gilrs.gamepads().find(|(_, gamepad)| gamepad.is_connected()) {
            fill_snapshot(&gamepad, &mut snapshot);
        }

        if let Ok(mut current) = state.lock() {
            *current = snapshot;
        }

        thread::sleep(Duration::from_millis(20));
    }
}

pub fn start(state: Arc<Mutex<GamepadSnapshot>>) {
    if let Err(e) = thread::Builder::new()
        .name("fluidcan-gamepad".to_string())
        .spawn(move || run(state))
    {
        eprintln!("native gamepad thread failed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn w3c_face_buttons_match_standard_layout() {
        assert_eq!(button_index(Button::South), Some(0));
        assert_eq!(button_index(Button::East), Some(1));
        assert_eq!(button_index(Button::West), Some(2));
        assert_eq!(button_index(Button::North), Some(3));
        assert_eq!(button_index(Button::LeftTrigger), Some(4));
        assert_eq!(button_index(Button::RightTrigger), Some(5));
        assert_eq!(button_index(Button::LeftTrigger2), Some(6));
        assert_eq!(button_index(Button::RightTrigger2), Some(7));
        assert_eq!(button_index(Button::DPadUp), Some(12));
        assert_eq!(button_index(Button::DPadDown), Some(13));
        assert_eq!(button_index(Button::DPadLeft), Some(14));
        assert_eq!(button_index(Button::DPadRight), Some(15));
    }

    #[test]
    fn sticks_are_negative_up() {
        assert_eq!(w3c_stick_y(1.0), -1.0);
        assert_eq!(w3c_stick_y(-1.0), 1.0);
    }
}
