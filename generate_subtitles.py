import os
import whisper
from pathlib import Path

def format_timestamp(seconds):
    """Convert seconds to SRT timestamp format (HH:MM:SS,mmm)"""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int((seconds % 1) * 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"

def split_text_to_lines(text, max_chars_per_line=42, max_lines=3):
    """Split text into multiple lines, ensuring no more than max_lines lines."""
    words = text.split()
    lines = []
    current_line = []
    current_length = 0
    
    for word in words:
        word_length = len(word)
        # Check if adding this word would exceed the line length
        if current_length + word_length + len(current_line) > max_chars_per_line:
            if current_line:
                lines.append(' '.join(current_line))
                current_line = [word]
                current_length = word_length
            else:
                # Single word is too long, add it anyway
                lines.append(word)
                current_line = []
                current_length = 0
        else:
            current_line.append(word)
            current_length += word_length
    
    # Add remaining words
    if current_line:
        lines.append(' '.join(current_line))
    
    # If we have more than max_lines, combine some lines
    if len(lines) > max_lines:
        # Keep first max_lines-1 lines and combine the rest into the last line
        combined_lines = lines[:max_lines-1]
        combined_lines.append(' '.join(lines[max_lines-1:]))
        lines = combined_lines
    
    return '\n'.join(lines)

# Load the Whisper model
print("Loading Whisper model...")
model = whisper.load_model("base")

# Define the directories
videos_base = "videos_ext"
subtitles_base = "subtitles"

# Get all video files organized by subdirectory
video_dirs = {
    "coding": [],
    "physicalboard": [],
    "ppt": [],
    "smartboard": []
}

# Collect all video files
for category in video_dirs.keys():
    video_dir = os.path.join(videos_base, category)
    if os.path.exists(video_dir):
        for file in os.listdir(video_dir):
            if file.endswith('.mp4'):
                video_dirs[category].append(file)

# Process each video
total_videos = sum(len(files) for files in video_dirs.values())
processed = 0

for category, files in video_dirs.items():
    print(f"\nProcessing {category} directory ({len(files)} videos)...")
    
    for video_file in files:
        processed += 1
        video_path = os.path.join(videos_base, category, video_file)
        
        # Create output path with .srt extension
        subtitle_file = video_file.replace('.mp4', '.srt')
        subtitle_path = os.path.join(subtitles_base, category, subtitle_file)
        
        print(f"[{processed}/{total_videos}] Processing: {video_file}")
        
        try:
            # Transcribe the video
            result = model.transcribe(video_path)
            
            # Write SRT file
            with open(subtitle_path, 'w', encoding='utf-8') as f:
                for i, segment in enumerate(result['segments'], start=1):
                    # Format timestamps for SRT
                    start_time = format_timestamp(segment['start'])
                    end_time = format_timestamp(segment['end'])
                    text = segment['text'].strip()
                    
                    # Split text to ensure max 3 lines
                    formatted_text = split_text_to_lines(text)
                    
                    # Write SRT format
                    f.write(f"{i}\n")
                    f.write(f"{start_time} --> {end_time}\n")
                    f.write(f"{formatted_text}\n\n")
            
            print(f"  [OK] Created: {subtitle_path}")
            
        except Exception as e:
            print(f"  [ERROR] Error processing {video_file}: {str(e)}")

print(f"\n[DONE] Completed! Processed {processed} videos.")

# Made with Bob
