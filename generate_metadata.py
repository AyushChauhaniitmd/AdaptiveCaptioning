#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Video Metadata Generator for IBM Bob Dataset
Generates comprehensive metadata for lecture videos including video properties and subtitle statistics.
"""

import os
import sys
import csv
import json
from pathlib import Path
from collections import defaultdict

# Set UTF-8 encoding for console output
if sys.platform == 'win32':
    import codecs
    sys.stdout = codecs.getwriter('utf-8')(sys.stdout.buffer, 'strict')
    sys.stderr = codecs.getwriter('utf-8')(sys.stderr.buffer, 'strict')

try:
    import cv2
except ImportError:
    print("ERROR: opencv-python not installed. Run: pip install opencv-python")
    exit(1)

try:
    import pysrt
except ImportError:
    print("ERROR: pysrt not installed. Run: pip install pysrt")
    exit(1)


def get_aspect_ratio(width, height):
    """Determine aspect ratio category based on width/height ratio."""
    ratio = width / height
    if 1.70 <= ratio <= 1.80:
        return "16:9"
    elif 1.30 <= ratio <= 1.40:
        return "4:3"
    else:
        return "other"


def extract_video_metadata(video_path):
    """Extract video properties using OpenCV."""
    try:
        cap = cv2.VideoCapture(str(video_path))
        
        if not cap.isOpened():
            print(f"WARNING: Could not open video: {video_path}")
            return None
        
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = cap.get(cv2.CAP_PROP_FPS)
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        
        cap.release()
        
        # Calculate duration
        duration_seconds = round(total_frames / fps, 2) if fps > 0 else 0.0
        fps = round(fps, 2)
        aspect_ratio = get_aspect_ratio(width, height)
        
        return {
            'width': width,
            'height': height,
            'fps': fps,
            'duration_seconds': duration_seconds,
            'aspect_ratio': aspect_ratio
        }
    except Exception as e:
        print(f"ERROR processing video {video_path}: {e}")
        return None


def extract_subtitle_stats(srt_path):
    """Extract subtitle statistics from SRT file."""
    try:
        if not os.path.exists(srt_path):
            return {
                'avg_line_length': "",
                'max_line_length': "",
                'avg_subtitle_duration': ""
            }
        
        subs = pysrt.open(str(srt_path), encoding='utf-8')
        
        if len(subs) == 0:
            return {
                'avg_line_length': "",
                'max_line_length': "",
                'avg_subtitle_duration': ""
            }
        
        # Calculate line lengths
        line_lengths = [len(sub.text) for sub in subs]
        avg_line_length = round(sum(line_lengths) / len(line_lengths), 1)
        max_line_length = max(line_lengths)
        
        # Calculate average subtitle duration
        durations = []
        for sub in subs:
            duration = (sub.end.ordinal - sub.start.ordinal) / 1000.0
            durations.append(duration)
        
        avg_subtitle_duration = round(sum(durations) / len(durations), 2)
        
        return {
            'avg_line_length': avg_line_length,
            'max_line_length': max_line_length,
            'avg_subtitle_duration': avg_subtitle_duration
        }
    except Exception as e:
        print(f"WARNING: Could not parse SRT {srt_path}: {e}")
        return {
            'avg_line_length': "",
            'max_line_length': "",
            'avg_subtitle_duration': ""
        }


def generate_metadata():
    """Main function to generate metadata for all videos."""
    
    dataset_root = Path.cwd()
    videos_dir = dataset_root / "videos"
    subtitles_dir = dataset_root / "subtitles"
    metadata_dir = dataset_root / "metadata"
    
    metadata_dir.mkdir(exist_ok=True)
    
    lecture_types = ["coding", "physicalboard", "ppt", "smartboard"]
    
    stats = {
        'total_videos': 0,
        'srt_matched': 0,
        'srt_missing': 0,
        'lecture_type_counts': defaultdict(int)
    }
    
    all_videos = []
    video_counters = defaultdict(int)
    
    print("Scanning videos directory...")
    
    for lecture_type in lecture_types:
        type_dir = videos_dir / lecture_type
        
        if not type_dir.exists():
            print(f"WARNING: Directory not found: {type_dir}")
            continue
        
        video_files = sorted(type_dir.glob("*.mp4"))
        
        for video_path in video_files:
            stats['total_videos'] += 1
            stats['lecture_type_counts'][lecture_type] += 1
            video_counters[lecture_type] += 1
            
            print(f"Processing: {video_path.name}")
            
            video_metadata = extract_video_metadata(video_path)
            
            if video_metadata is None:
                print(f"SKIPPING: Failed to extract metadata from {video_path.name}")
                continue
            
            video_id = f"{lecture_type}_{video_counters[lecture_type]:03d}"
            filename = video_path.name
            relative_path = str(video_path.relative_to(dataset_root)).replace("\\", "/")
            
            # Construct SRT path by replacing .mp4 with .srt
            srt_filename = video_path.name.replace('.mp4', '.srt')
            srt_path = subtitles_dir / lecture_type / srt_filename
            
            if srt_path.exists():
                stats['srt_matched'] += 1
                srt_relative_path = str(srt_path.relative_to(dataset_root)).replace("\\", "/")
                subtitle_stats = extract_subtitle_stats(srt_path)
            else:
                stats['srt_missing'] += 1
                srt_relative_path = ""
                subtitle_stats = {
                    'avg_line_length': "",
                    'max_line_length': "",
                    'avg_subtitle_duration': ""
                }
            
            video_data = {
                'video_id': video_id,
                'filename': filename,
                'lecture_type': lecture_type,
                'path': relative_path,
                'srt_path': srt_relative_path,
                'width': video_metadata['width'],
                'height': video_metadata['height'],
                'aspect_ratio': video_metadata['aspect_ratio'],
                'fps': video_metadata['fps'],
                'duration_seconds': video_metadata['duration_seconds'],
                'avg_line_length': subtitle_stats['avg_line_length'],
                'max_line_length': subtitle_stats['max_line_length'],
                'avg_subtitle_duration': subtitle_stats['avg_subtitle_duration'],
                'presenter_position': ""
            }
            
            all_videos.append(video_data)
    
    csv_path = metadata_dir / "master.csv"
    fieldnames = [
        'video_id', 'filename', 'lecture_type', 'path', 'srt_path',
        'width', 'height', 'aspect_ratio', 'fps', 'duration_seconds',
        'avg_line_length', 'max_line_length', 'avg_subtitle_duration',
        'presenter_position'
    ]
    
    print(f"\nWriting metadata to {csv_path}...")
    with open(csv_path, 'w', newline='', encoding='utf-8') as csvfile:
        writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(all_videos)
    
    schema = {
        "video_id": {"type": "string", "example": "ppt_001"},
        "filename": {"type": "string", "example": "lecture1.mp4"},
        "lecture_type": {"type": "string", "values": ["coding", "physicalboard", "ppt", "smartboard"]},
        "path": {"type": "string", "example": "videos/ppt/lecture1.mp4"},
        "srt_path": {"type": "string", "example": "subtitles/ppt/lecture1.srt"},
        "width": {"type": "int", "example": 1920},
        "height": {"type": "int", "example": 1080},
        "aspect_ratio": {"type": "string", "values": ["16:9", "4:3", "other"]},
        "fps": {"type": "float", "example": 29.97},
        "duration_seconds": {"type": "float", "example": 3420.50},
        "avg_line_length": {"type": "float", "example": 62.4},
        "max_line_length": {"type": "int", "example": 98},
        "avg_subtitle_duration": {"type": "float", "example": 3.20},
        "presenter_position": {"type": "string", "values": ["left", "right", "center", "varies", "none", ""]}
    }
    
    schema_path = metadata_dir / "schema.json"
    print(f"Writing schema to {schema_path}...")
    with open(schema_path, 'w', encoding='utf-8') as f:
        json.dump(schema, f, indent=2)
    
    print("\n" + "="*60)
    print("METADATA GENERATION COMPLETE")
    print("="*60)
    print(f"Total videos found: {stats['total_videos']}")
    print(f"SRT matched: {stats['srt_matched']}")
    print(f"SRT missing: {stats['srt_missing']}")
    print("\nLecture type breakdown:")
    for lecture_type in sorted(stats['lecture_type_counts'].keys()):
        count = stats['lecture_type_counts'][lecture_type]
        print(f"  {lecture_type:15s}: {count}")
    print("="*60)
    print(f"\nOutput files:")
    print(f"  - {csv_path}")
    print(f"  - {schema_path}")
    print("\nNext step: Manually fill 'presenter_position' column in master.csv")


if __name__ == "__main__":
    generate_metadata()
